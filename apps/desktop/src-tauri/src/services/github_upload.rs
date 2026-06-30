//! GitHub user-attachments image upload — a Rust/reqwest reimplementation of gh-image's
//! protocol (github.com/drogers0/gh-image, internal/upload/*.go), driven by the github.com
//! `user_session` web-session cookie (these endpoints reject OAuth/PAT tokens — see github.rs).
//!
//! The 4-step protocol (all against https://github.com except the S3 step), verbatim from
//! gh-image, reproduced here field-for-field:
//!
//!   Step 0  GET  https://github.com/{owner}/{repo}
//!           → scrape `"uploadToken":"<token>"` (regex against the embedded JSON in the HTML),
//!             and the numeric repository id (octolytics meta / embedded payload).
//!   Step 1  POST https://github.com/upload/policies/assets   (multipart/form-data)
//!           fields IN ORDER: name, size, content_type, authenticity_token (=uploadToken),
//!             repository_id.
//!           → JSON { upload_url, asset:{ id, name, size, content_type, href }, form:{...},
//!             asset_upload_url (root-relative path), asset_upload_authenticity_token }.
//!   Step 2  POST {policy.upload_url}  (S3 presigned, multipart/form-data, NO github cookies)
//!           all `form` fields first (deterministic order), then the file as field "file" LAST.
//!           → 204 / 200 / 201 (body discarded).
//!   Step 3  PUT  https://github.com{policy.asset_upload_url}   (multipart/form-data)
//!           field: authenticity_token (=policy.asset_upload_authenticity_token — a DIFFERENT
//!             token than step 1's uploadToken).
//!           → JSON { href, name }. `href` is the FINAL user-attachments URL.
//!
//! Headers (github.com steps 0/1/3): Cookie (user_session + __Host-user_session_same_site, same
//! value), Accept: application/json (1/3), Content-Type multipart boundary (1/3), Origin
//! https://github.com (1/3), Referer https://github.com/{owner}/{repo} (1/3),
//! X-Requested-With: XMLHttpRequest (1/3), User-Agent. The S3 step (2) sends NO github cookies
//! and only Content-Type + Origin + User-Agent. gh-image does NOT send GitHub-Verified-Fetch on
//! these endpoints — the dual-cookie pair + Origin/Referer/X-Requested-With satisfies the CSRF
//! check.

use reqwest::multipart;
use serde::Deserialize;
use std::collections::BTreeMap;

use super::github::{cookie_header, github_client, USER_AGENT};
use super::{Result, ServiceError};

const GH: &str = "https://github.com";

/// Step 1 / Step 3 response shape (verbatim from gh-image's `policyResponse`).
#[derive(Debug, Deserialize)]
struct PolicyResponse {
    upload_url: String,
    /// Parsed for completeness (gh-image reads asset.content_type for markdown choice); the
    /// desktop composes markdown on the TS side, so the field is unused here.
    #[allow(dead_code)]
    asset: PolicyAsset,
    form: BTreeMap<String, String>,
    asset_upload_url: String,
    asset_upload_authenticity_token: String,
}

#[derive(Debug, Deserialize)]
struct PolicyAsset {
    #[allow(dead_code)]
    id: i64,
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    content_type: String,
}

#[derive(Debug, Deserialize)]
struct FinalizeResponse {
    href: String,
    #[allow(dead_code)]
    name: String,
}

/// Upload one image (a `data:` URL) to the repo's user-attachments and return the final
/// `https://github.com/user-attachments/assets/<uuid>` URL. `session` is the user_session value.
pub async fn upload_image(
    session: &str,
    owner: &str,
    repo: &str,
    data_url: &str,
    filename: &str,
) -> Result<String> {
    let (bytes, content_type) = decode_data_url(data_url, filename)?;
    let client = github_client()?;
    let referer = format!("{GH}/{owner}/{repo}");

    // Step 0: scrape the upload token + repository id from the repo HTML page.
    let page = client
        .get(&referer)
        .header(reqwest::header::COOKIE, cookie_header(session))
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("fetch repo page: {e}")))?;
    if !page.status().is_success() {
        return Err(ServiceError::Other(format!(
            "GitHub repo page returned {} (signed out, or no access to {owner}/{repo})",
            page.status()
        )));
    }
    let html = page
        .text()
        .await
        .map_err(|e| ServiceError::Other(format!("read repo page: {e}")))?;
    let upload_token = scrape_upload_token(&html)
        .ok_or_else(|| ServiceError::Other("could not find the GitHub uploadToken (signed out, SSO interstitial, or no repo access)".into()))?;
    let repository_id = scrape_repository_id(&html)
        .ok_or_else(|| ServiceError::Other("could not find the repository id on the repo page".into()))?;

    // Step 1: request the upload policy. Multipart fields IN ORDER (gh-image order).
    let form = multipart::Form::new()
        .text("name", filename.to_string())
        .text("size", bytes.len().to_string())
        .text("content_type", content_type.clone())
        .text("authenticity_token", upload_token)
        .text("repository_id", repository_id);
    let policy_resp = client
        .post(format!("{GH}/upload/policies/assets"))
        .header(reqwest::header::COOKIE, cookie_header(session))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ORIGIN, GH)
        .header(reqwest::header::REFERER, &referer)
        .header("X-Requested-With", "XMLHttpRequest")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .multipart(form)
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("upload policy request: {e}")))?;
    if policy_resp.status().as_u16() != 201 {
        let status = policy_resp.status();
        let detail = policy_resp.text().await.unwrap_or_default();
        return Err(ServiceError::Other(format!(
            "GitHub upload policy failed ({status}): {}",
            detail.chars().take(200).collect::<String>()
        )));
    }
    let policy: PolicyResponse = policy_resp
        .json()
        .await
        .map_err(|e| ServiceError::Other(format!("parse upload policy: {e}")))?;
    if !policy.asset_upload_url.starts_with('/') {
        return Err(ServiceError::Other(format!(
            "unexpected asset_upload_url (not root-relative): {}",
            policy.asset_upload_url
        )));
    }

    // Step 2: S3 presigned multipart POST. The `form` fields first (deterministic order: the
    // known S3 keys in gh-image's order, then any leftovers), then the file LAST. NO github
    // cookies — the presigned policy carries its own auth. Use a fresh client (no UA cookie risk).
    upload_to_s3(&policy, &bytes, filename, &content_type).await?;

    // Step 3: finalize. The authenticity_token here is the policy's asset_upload_authenticity_token
    // (a DIFFERENT token than step 1). The response href is the final user-attachments URL.
    let finalize_form =
        multipart::Form::new().text("authenticity_token", policy.asset_upload_authenticity_token.clone());
    let finalize_resp = client
        .put(format!("{GH}{}", policy.asset_upload_url))
        .header(reqwest::header::COOKIE, cookie_header(session))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ORIGIN, GH)
        .header(reqwest::header::REFERER, &referer)
        .header("X-Requested-With", "XMLHttpRequest")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .multipart(finalize_form)
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("finalize request: {e}")))?;
    if !finalize_resp.status().is_success() {
        let status = finalize_resp.status();
        let detail = finalize_resp.text().await.unwrap_or_default();
        return Err(ServiceError::Other(format!(
            "GitHub upload finalize failed ({status}): {}",
            detail.chars().take(200).collect::<String>()
        )));
    }
    let finalize: FinalizeResponse = finalize_resp
        .json()
        .await
        .map_err(|e| ServiceError::Other(format!("parse finalize response: {e}")))?;
    Ok(finalize.href)
}

/// gh-image's deterministic S3 field order; the file is always written LAST.
const S3_FIELD_ORDER: &[&str] = &[
    "key",
    "acl",
    "policy",
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Signature",
    "Content-Type",
    "Cache-Control",
    "x-amz-meta-Surrogate-Control",
];

async fn upload_to_s3(
    policy: &PolicyResponse,
    bytes: &[u8],
    filename: &str,
    content_type: &str,
) -> Result<()> {
    let mut form = multipart::Form::new();
    // Known fields first, in gh-image's order.
    for &k in S3_FIELD_ORDER {
        if let Some(v) = policy.form.get(k) {
            form = form.text(k.to_string(), v.clone());
        }
    }
    // Any leftover presigned fields not in the known list (order-independent for S3).
    for (k, v) in &policy.form {
        if !S3_FIELD_ORDER.contains(&k.as_str()) {
            form = form.text(k.clone(), v.clone());
        }
    }
    // The file MUST be the last field.
    let part = multipart::Part::bytes(bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str(content_type)
        .map_err(|e| ServiceError::Other(format!("s3 file part: {e}")))?;
    form = form.part("file", part);

    // A separate client with NO cookie jar (we never set a Cookie header here anyway).
    let s3_client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| ServiceError::Other(format!("s3 client: {e}")))?;
    let resp = s3_client
        .post(&policy.upload_url)
        .header(reqwest::header::ORIGIN, GH)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .multipart(form)
        .send()
        .await
        .map_err(|e| ServiceError::Other(format!("S3 upload: {e}")))?;
    // gh-image accepts 204 (typical), 200, or 201.
    match resp.status().as_u16() {
        200 | 201 | 204 => Ok(()),
        other => {
            let detail = resp.text().await.unwrap_or_default();
            Err(ServiceError::Other(format!(
                "S3 upload failed ({other}): {}",
                detail.chars().take(200).collect::<String>()
            )))
        }
    }
}

/// Decode a `data:<mime>;base64,<...>` URL into (bytes, mime). Falls back to image/png if the
/// mime is absent. Sends the BARE media type (no `;charset=` parameter), matching gh-image.
fn decode_data_url(data_url: &str, _filename: &str) -> Result<(Vec<u8>, String)> {
    use base64::Engine;
    let comma = data_url
        .find(',')
        .ok_or_else(|| ServiceError::Other("malformed data URL (no comma)".into()))?;
    let header = &data_url[..comma];
    let payload = &data_url[comma + 1..];
    // header looks like "data:image/png;base64"
    let mime = header
        .strip_prefix("data:")
        .and_then(|h| h.split(';').next())
        .filter(|m| !m.is_empty())
        .unwrap_or("image/png")
        .to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| ServiceError::Other(format!("decode image data: {e}")))?;
    Ok((bytes, mime))
}

/// Step 0a: the upload-specific token, embedded in the repo page's JSON as `"uploadToken":"..."`.
/// This is distinct from a generic page CSRF `authenticity_token`.
fn scrape_upload_token(html: &str) -> Option<String> {
    extract_json_string(html, "\"uploadToken\":\"")
}

/// Step 0b: the numeric repository id. GitHub renders it as an octolytics meta tag on the repo
/// page for both public and signed-in private repos; fall back to the embedded `"repoId":<n>`
/// / `"repository_id":<n>` JSON if the meta tag layout changes.
fn scrape_repository_id(html: &str) -> Option<String> {
    // Preferred: <meta name="octolytics-dimension-repository_id" content="123456">
    if let Some(idx) = html.find("octolytics-dimension-repository_id") {
        let after = &html[idx..];
        if let Some(c) = after.find("content=\"") {
            let rest = &after[c + "content=\"".len()..];
            if let Some(end) = rest.find('"') {
                let id = rest[..end].trim();
                if id.chars().all(|ch| ch.is_ascii_digit()) && !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    // Fallbacks: embedded JSON numeric keys.
    extract_json_number(html, "\"repository_id\":").or_else(|| extract_json_number(html, "\"repoId\":"))
}

/// Find `key"<value>"` and return the string value (key includes the trailing `"`).
fn extract_json_string(html: &str, key: &str) -> Option<String> {
    let idx = html.find(key)?;
    let rest = &html[idx + key.len()..];
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Find `key<number>` (key ends just before the digits) and return the digit run.
fn extract_json_number(html: &str, key: &str) -> Option<String> {
    let idx = html.find(key)?;
    let rest = &html[idx + key.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrapes_upload_token() {
        let html = r#"...,"uploadToken":"abc.def-123","other":1..."#;
        assert_eq!(scrape_upload_token(html).as_deref(), Some("abc.def-123"));
    }

    #[test]
    fn scrapes_repository_id_from_meta() {
        let html = r#"<meta name="octolytics-dimension-repository_id" content="987654" />"#;
        assert_eq!(scrape_repository_id(html).as_deref(), Some("987654"));
    }

    #[test]
    fn scrapes_repository_id_fallback_json() {
        let html = r#"{"repository_id":42,"x":1}"#;
        assert_eq!(scrape_repository_id(html).as_deref(), Some("42"));
    }

    #[test]
    fn decodes_png_data_url() {
        // "iVBORw0KGgo=" is a 7-byte prefix; just confirm decoding + mime parse.
        let (bytes, mime) = decode_data_url("data:image/png;base64,aGVsbG8=", "x.png").unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn data_url_defaults_mime_to_png() {
        let (_b, mime) = decode_data_url("data:;base64,aGk=", "x").unwrap();
        assert_eq!(mime, "image/png");
    }
}
