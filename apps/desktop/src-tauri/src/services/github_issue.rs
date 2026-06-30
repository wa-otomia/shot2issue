//! GitHub issue creation via the github.com WEB SESSION cookie (no OAuth/PAT) — the same
//! `user_session` that drives the user-attachments upload (see github_upload.rs), so an uploaded
//! screenshot embedded in the body renders correctly (it was uploaded under the same session).
//!
//! Approach — the no-JS Rails form POST (primary, most stable):
//!   GitHub still serves a plain <form> on /{owner}/{repo}/issues/new for clients without JS, and
//!   accepts its POST to /{owner}/{repo}/issues. We:
//!     1. GET  https://github.com/{owner}/{repo}/issues/new  → scrape the issue form's hidden
//!        `authenticity_token` (the per-form CSRF token Rails embeds in the <form>).
//!     2. POST https://github.com/{owner}/{repo}/issues  as application/x-www-form-urlencoded with
//!        `authenticity_token`, `issue[title]`, `issue[body]`. GitHub replies 302 → the created
//!        issue URL (in the Location header), which we return.
//!   Headers: Cookie (user_session + __Host-user_session_same_site, same value — github.rs),
//!   Origin/Referer https://github.com/..., and GitHub-Verified-Fetch: true (GitHub's CSRF guard
//!   on cookie-authenticated state-changing requests). reqwest is told NOT to auto-follow
//!   redirects so we can read the Location of the 302.
//!
//! ============================== mac/win VERIFICATION POINT ==============================
//! This path cannot run on the headless-Linux CI box (no signed-in github.com session). The
//! form-field names (`authenticity_token`, `issue[title]`, `issue[body]`) and the 302-Location
//! behavior are the long-standing GitHub no-JS form contract, but GitHub's web UI evolves; if a
//! future change breaks the form POST, the documented alternative is the web GraphQL endpoint
//! POST https://github.com/_graphql with the `createIssue` mutation, the repo's GraphQL node id,
//! and the `GitHub-Verified-Fetch: true` + `X-Requested-With: XMLHttpRequest` headers. The
//! verifier should confirm the form path on a real signed-in mac/win build first; it's simpler
//! and avoids depending on internal GraphQL ids. Both ride the one web session.
//! =======================================================================================

use super::github::{cookie_header, USER_AGENT};
use super::{Result, ServiceError};

const GH: &str = "https://github.com";

/// Create an issue in {owner}/{repo} via the web session. `session` is the user_session value;
/// `body` already has any uploaded-image markdown embedded (the caller composes it). Returns the
/// created issue URL (e.g. https://github.com/{owner}/{repo}/issues/123).
pub async fn create_issue(
    session: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
) -> Result<String> {
    // A client that does NOT auto-follow redirects, so we can read the 302 Location (the new
    // issue URL) instead of following it into the rendered issue page.
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| ServiceError::Other(format!("http client: {e}")))?;

    let new_url = format!("{GH}/{owner}/{repo}/issues/new");

    // 1) Scrape the issue form's authenticity_token from the new-issue page.
    let page = client
        .get(&new_url)
        .header(reqwest::header::COOKIE, cookie_header(session))
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("fetch new-issue page: {e}")))?;
    // A signed-out session redirects to /login (302); treat any non-200 as "can't reach the form".
    if !page.status().is_success() {
        return Err(ServiceError::Other(format!(
            "GitHub new-issue page returned {} (signed out, or no access to {owner}/{repo})",
            page.status()
        )));
    }
    let html = page
        .text()
        .await
        .map_err(|e| ServiceError::Other(format!("read new-issue page: {e}")))?;
    let token = scrape_form_authenticity_token(&html).ok_or_else(|| {
        ServiceError::Other(
            "could not find the issue form's authenticity_token (the new-issue page may be the JS-only composer, or the repo enforces issue templates)".into(),
        )
    })?;

    // 2) POST the form. application/x-www-form-urlencoded with the Rails issue[...] fields.
    let params = [
        ("authenticity_token", token.as_str()),
        ("issue[title]", title),
        ("issue[body]", body),
    ];
    let referer = new_url.clone();
    let resp = client
        .post(format!("{GH}/{owner}/{repo}/issues"))
        .header(reqwest::header::COOKIE, cookie_header(session))
        .header(reqwest::header::ORIGIN, GH)
        .header(reqwest::header::REFERER, &referer)
        .header("GitHub-Verified-Fetch", "true")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .form(&params)
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("create issue request: {e}")))?;

    // Success is a 302 redirect to the created issue; read the Location header.
    let status = resp.status();
    if status.is_redirection() {
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION).and_then(|h| h.to_str().ok()) {
            return Ok(absolutize(loc));
        }
    }
    // Some GitHub responses 200 with the issue page; try to recover the URL from the body.
    if status.is_success() {
        let html = resp.text().await.unwrap_or_default();
        if let Some(url) = scrape_created_issue_url(&html, owner, repo) {
            return Ok(url);
        }
    }
    Err(ServiceError::Other(format!(
        "GitHub issue creation did not redirect to a new issue (HTTP {status}); the form contract may have changed — see github_issue.rs"
    )))
}

/// Resolve a possibly-relative Location header to an absolute github.com URL.
fn absolutize(loc: &str) -> String {
    if loc.starts_with("http://") || loc.starts_with("https://") {
        loc.to_string()
    } else if loc.starts_with('/') {
        format!("{GH}{loc}")
    } else {
        format!("{GH}/{loc}")
    }
}

/// Scrape the FIRST hidden `authenticity_token` value from the page. On the new-issue page this
/// is the issue form's CSRF token. We look for `name="authenticity_token"` then the nearby
/// `value="..."` (attribute order is name-before-value in Rails' hidden field).
fn scrape_form_authenticity_token(html: &str) -> Option<String> {
    let mut search = html;
    while let Some(idx) = search.find("name=\"authenticity_token\"") {
        // Look at a window around this input tag for value="...". Rails renders
        // <input type="hidden" name="authenticity_token" value="TOKEN" autocomplete="off" />
        let after = &search[idx..];
        // Bound the search to this tag (up to the next '>').
        let tag_end = after.find('>').unwrap_or(after.len());
        let tag = &after[..tag_end];
        if let Some(v) = attr_value(tag, "value") {
            if !v.is_empty() {
                return Some(v);
            }
        }
        // Also handle value-before-name ordering: re-scan the preceding input open tag.
        if let Some(open) = search[..idx].rfind("<input") {
            let tag = &search[open..idx + tag_end];
            if let Some(v) = attr_value(tag, "value") {
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
        // Advance past this match and keep looking.
        search = &after[tag_end.min(after.len())..];
    }
    None
}

/// Extract `attr="value"` from a tag fragment.
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let key = format!("{attr}=\"");
    let idx = tag.find(&key)?;
    let rest = &tag[idx + key.len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Best-effort: pull a /{owner}/{repo}/issues/{n} URL out of a returned HTML page.
fn scrape_created_issue_url(html: &str, owner: &str, repo: &str) -> Option<String> {
    let needle = format!("/{owner}/{repo}/issues/");
    let idx = html.find(&needle)?;
    let rest = &html[idx + needle.len()..];
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if num.is_empty() {
        None
    } else {
        Some(format!("{GH}{needle}{num}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrapes_authenticity_token_name_before_value() {
        let html = r#"<form><input type="hidden" name="authenticity_token" value="TOK123" autocomplete="off" /></form>"#;
        assert_eq!(scrape_form_authenticity_token(html).as_deref(), Some("TOK123"));
    }

    #[test]
    fn scrapes_authenticity_token_value_before_name() {
        let html = r#"<input type="hidden" value="TOK456" name="authenticity_token">"#;
        assert_eq!(scrape_form_authenticity_token(html).as_deref(), Some("TOK456"));
    }

    #[test]
    fn absolutize_handles_relative_and_absolute() {
        assert_eq!(absolutize("/o/r/issues/9"), "https://github.com/o/r/issues/9");
        assert_eq!(absolutize("https://github.com/o/r/issues/9"), "https://github.com/o/r/issues/9");
    }

    #[test]
    fn scrapes_created_issue_url() {
        let html = r#"<a href="/octocat/hello/issues/42">#42</a>"#;
        assert_eq!(
            scrape_created_issue_url(html, "octocat", "hello").as_deref(),
            Some("https://github.com/octocat/hello/issues/42")
        );
    }
}
