//! GitHub via the github.com WEB SESSION cookie — no OAuth, no PAT.
//!
//! USER DECISION: GitHub uses COOKIES for EVERYTHING. A built-in GitHub-login webview obtains
//! the `user_session` cookie once; that single session drives BOTH image upload
//! (user-attachments, see github_upload.rs) AND issue creation (see github_issue.rs). Rationale:
//! the user-attachments upload endpoints are web-session-only — OAuth/PAT tokens are rejected
//! there — so cookie-for-everything avoids running two auth systems.
//!
//! This module owns:
//!   (a) the login flow: open a GitHub-login WebviewWindow, then read the `user_session` cookie
//!       once the user is signed in, and persist it (commands `github_login` + the cookie read);
//!   (b) `github_session_status`: report whether a session cookie is present + which login it is;
//!   (c) the shared reqwest client + cookie header + headers/User-Agent the upload/issue paths use.
//!
//! ============================== mac/win VERIFICATION POINT ==============================
//! Reading the cookie uses Tauri 2's `WebviewWindow::cookies_for_url()` (added in tauri 2.4.0;
//! this app pins tauri 2.11.x). That API is backed by wry's cookie getters:
//!   - macOS:   WKHTTPCookieStore (WKWebView)   — supported
//!   - Windows: WebView2 CookieManager          — supported (NOTE: Tauri docs warn this call can
//!              DEADLOCK if invoked from a *synchronous* command/event handler, so `github_login`
//!              and `github_session_status` are `async` commands and the read runs on the async
//!              runtime — see commands.rs.)
//!   - Linux:   WebKitGTK cookie manager         — supported, but the headless-Linux CI box has no
//!              display, so this whole path CANNOT be exercised here. It is correct-by-construction
//!              + commented; the user verifies on mac/win.
//! `cookies_for_url` only returns cookies for http/https URLs (not tauri://), which is why we
//! query `https://github.com`. HttpOnly cookies (user_session is HttpOnly) ARE included by this
//! API (it reads the platform cookie store, not document.cookie). If a future platform/runtime
//! returns an empty Vec, fall back to the persisted cookie from a prior successful login.
//! =======================================================================================

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use super::{Result, ServiceError};

/// Browser-like UA used on every github.com request (mirrors gh-image's constant). GitHub's
/// upload endpoints are picky about a plausible browser UA on cookie-authenticated requests.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/// Persisted store file (shared with settings.rs and the JS-side plugin-store name).
const STORE_FILE: &str = "settings.json";
/// Store key holding the captured `user_session` cookie value.
const KEY_SESSION: &str = "githubUserSession";
/// Store key holding the last-known github.com login (handle), for the status hint.
const KEY_LOGIN: &str = "githubLogin";
/// The login webview window label.
const LOGIN_LABEL: &str = "github-login";

/// Reported to the frontend (serde camelCase → { loggedIn, login }). Mirrors the extension's
/// `checkGithubLogin` result so the core GitHub provider hint/gate is unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub logged_in: bool,
    pub login: String,
}

/// In-process cache of the session cookie value so the upload/issue paths don't re-read the
/// store on every request. Populated on login and on first status check.
static SESSION_CACHE: Mutex<Option<String>> = Mutex::new(None);

// ---- persistence -------------------------------------------------------------

fn persist_session<R: Runtime>(app: &AppHandle<R>, value: &str, login: &str) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(KEY_SESSION, value);
        store.set(KEY_LOGIN, login);
        let _ = store.save();
    }
    *SESSION_CACHE.lock().unwrap() = Some(value.to_string());
}

fn stored_session<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    if let Some(v) = SESSION_CACHE.lock().unwrap().clone() {
        return Some(v);
    }
    let store = app.store(STORE_FILE).ok()?;
    let v = store.get(KEY_SESSION).and_then(|v| v.as_str().map(str::to_string))?;
    *SESSION_CACHE.lock().unwrap() = Some(v.clone());
    Some(v)
}

fn stored_login<R: Runtime>(app: &AppHandle<R>) -> String {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(KEY_LOGIN).and_then(|v| v.as_str().map(str::to_string)))
        .unwrap_or_default()
}

/// The cookie value the upload/issue paths use. `None` ⇒ not signed in.
pub fn session_cookie<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    stored_session(app)
}

/// Build the `Cookie:` header value GitHub's CSRF check requires on cookie-authenticated
/// endpoints: BOTH `user_session` AND `__Host-user_session_same_site`, carrying the SAME value
/// (gh-image synthesizes the second cookie this way; GitHub's verified-fetch check needs the pair).
pub fn cookie_header(session_value: &str) -> String {
    format!("user_session={session_value}; __Host-user_session_same_site={session_value}")
}

// ---- cookie read (mac/win verification point — see module header) ------------

/// Read the `user_session` cookie value from the webview's platform cookie store for
/// https://github.com. Returns None if absent (signed out) or unsupported on this platform.
fn read_user_session<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    // Prefer the dedicated login window's cookie store; fall back to the main window. Both share
    // the app's cookie store on every supported platform.
    let win = app
        .get_webview_window(LOGIN_LABEL)
        .or_else(|| app.get_webview_window("main"))?;
    let url = "https://github.com".parse().ok()?;
    // cookies_for_url returns the cookie crate's Cookie, including HttpOnly + Secure cookies.
    let cookies = win.cookies_for_url(url).ok()?;
    cookies
        .into_iter()
        .find(|c| c.name() == "user_session")
        .map(|c| c.value().to_string())
}

// ---- login flow --------------------------------------------------------------

/// Open (or focus) the built-in GitHub-login webview, then poll the cookie store until the
/// `user_session` cookie appears (the user has signed in) or a timeout elapses. On success the
/// cookie is persisted and the resolved login is returned.
///
/// Async (Tauri requires async for the cookie read on Windows — see module header). The poll is
/// cheap (a cookie-store read every 500ms); the window stays open so the user can complete 2FA.
pub async fn login<R: Runtime>(app: &AppHandle<R>) -> Result<SessionStatus> {
    open_login_window(app)?;

    // Poll for up to ~3 minutes (covers email + 2FA). The user closing the window early surfaces
    // as "still signed out" rather than an error.
    for _ in 0..360 {
        if app.get_webview_window(LOGIN_LABEL).is_none() {
            // The user closed the login window. Read once more in case the cookie was just set.
            break;
        }
        if let Some(value) = read_user_session(app) {
            let login = resolve_login(app, &value).await.unwrap_or_default();
            persist_session(app, &value, &login);
            // Sign-in complete: close the login window so it doesn't linger.
            if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
                let _ = win.close();
            }
            return Ok(SessionStatus { logged_in: true, login });
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // One final read after the loop (e.g. window just closed post-login).
    if let Some(value) = read_user_session(app) {
        let login = resolve_login(app, &value).await.unwrap_or_default();
        persist_session(app, &value, &login);
        return Ok(SessionStatus { logged_in: true, login });
    }
    Ok(SessionStatus {
        logged_in: false,
        login: String::new(),
    })
}

fn open_login_window<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // Load github.com/login directly in the webview. The user signs in there; the resulting
    // session cookie lands in the app's cookie store, which read_user_session() then reads.
    WebviewWindowBuilder::new(
        app,
        LOGIN_LABEL,
        WebviewUrl::External(
            "https://github.com/login"
                .parse()
                .map_err(|e| ServiceError::Other(format!("login url: {e}")))?,
        ),
    )
    .title("Sign in to GitHub")
    .inner_size(560.0, 720.0)
    .resizable(true)
    .center()
    .focused(true)
    .build()
    .map_err(|e| ServiceError::Other(format!("github login window: {e}")))?;
    Ok(())
}

// ---- session status ----------------------------------------------------------

/// Report the current session: is a `user_session` cookie present, and which login is it?
/// Prefers a live cookie-store read (so a sign-out elsewhere is noticed); falls back to the
/// persisted cookie. Verifies the cookie still works by resolving the login from github.com.
pub async fn session_status<R: Runtime>(app: &AppHandle<R>) -> SessionStatus {
    // A live read keeps us honest if the user signed out via the login window; otherwise use the
    // persisted value (the login window is usually closed during normal use).
    let value = read_user_session(app).or_else(|| stored_session(app));
    let Some(value) = value else {
        return SessionStatus {
            logged_in: false,
            login: String::new(),
        };
    };
    match resolve_login(app, &value).await {
        Some(login) if !login.is_empty() => {
            persist_session(app, &value, &login);
            SessionStatus { logged_in: true, login }
        }
        // The cookie exists but github.com didn't return a login (expired/revoked). Report the
        // last-known handle but flagged signed-out so the UI prompts a re-login.
        _ => SessionStatus {
            logged_in: false,
            login: stored_login(app),
        },
    }
}

/// Confirm the session cookie is live and learn the login: fetch github.com and scrape the
/// `<meta name="user-login" content="...">` tag GitHub renders for signed-in users (extension
/// parity with checkGithubLogin). Returns None on network error or signed-out HTML.
async fn resolve_login<R: Runtime>(app: &AppHandle<R>, session_value: &str) -> Option<String> {
    let _ = app; // reserved for future per-app client config; keep signature uniform
    let client = github_client().ok()?;
    let resp = client
        .get("https://github.com/")
        .header(reqwest::header::COOKIE, cookie_header(session_value))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().await.ok()?;
    scrape_user_login(&html)
}

/// Extract the signed-in user handle from github.com HTML: <meta name="user-login" content="..">.
fn scrape_user_login(html: &str) -> Option<String> {
    // Minimal, allocation-light scrape (no HTML parser dep): find the meta tag, then its content.
    let key = "name=\"user-login\"";
    let idx = html.find(key)?;
    let after = &html[idx..];
    let content_idx = after.find("content=\"")? + "content=\"".len();
    let rest = &after[content_idx..];
    let end = rest.find('"')?;
    let login = rest[..end].trim();
    if login.is_empty() {
        None
    } else {
        Some(login.to_string())
    }
}

// ---- shared reqwest client ---------------------------------------------------

/// A reqwest client with the browser UA every github.com request uses. No cookie jar: each
/// request sets the Cookie header explicitly (the S3 step must send NO cookies, so a shared jar
/// would be wrong — see github_upload.rs).
pub fn github_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| ServiceError::Other(format!("http client: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_header_synthesizes_the_same_site_pair() {
        assert_eq!(
            cookie_header("abc123"),
            "user_session=abc123; __Host-user_session_same_site=abc123"
        );
    }

    #[test]
    fn scrapes_user_login_meta() {
        let html = r#"<head><meta name="user-login" content="octocat"></head>"#;
        assert_eq!(scrape_user_login(html).as_deref(), Some("octocat"));
    }

    #[test]
    fn scrape_returns_none_when_signed_out() {
        assert_eq!(scrape_user_login("<head></head>"), None);
        assert_eq!(scrape_user_login(r#"<meta name="user-login" content="">"#), None);
    }
}
