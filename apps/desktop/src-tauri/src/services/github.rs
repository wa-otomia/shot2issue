//! GitHub via github.com WEB SESSION cookies — no OAuth, no PAT. Supports MULTIPLE accounts.
//!
//! USER DECISION: GitHub uses COOKIES for EVERYTHING. A built-in GitHub-login webview obtains a
//! `user_session` cookie; that session drives BOTH image upload (user-attachments, see
//! github_upload.rs) AND issue creation (see github_issue.rs). Rationale: the user-attachments
//! upload endpoints are web-session-only — OAuth/PAT tokens are rejected there — so
//! cookie-for-everything avoids running two auth systems.
//!
//! MULTI-ACCOUNT: each signed-in account is stored as { login, session } in the app store
//! (key `githubAccounts`). The account id IS the github login (unique + stable enough). The
//! upload/issue commands take a session chosen by account id, so different workspaces can file
//! as different accounts. Adding an account opens the login webview; the user signs in (GitHub's
//! login page offers "sign in to a different account" to add a second identity), and the captured
//! `user_session` is upserted by login. Because the session lives in the APP store — not only the
//! webview cookie store — multiple accounts coexist even though the webview holds one live
//! github.com session at a time.
//!
//! ============================== mac/win VERIFICATION POINT ==============================
//! Reading the cookie uses Tauri 2's `WebviewWindow::cookies_for_url()` (tauri 2.4.0+; this app
//! pins 2.11.x), backed by wry's cookie getters:
//!   - macOS:   WKHTTPCookieStore (WKWebView)   — supported
//!   - Windows: WebView2 CookieManager          — supported (Tauri warns this can DEADLOCK from a
//!              *synchronous* command; `github_login`/`github_accounts` are `async` — see commands.rs)
//!   - Linux:   WebKitGTK cookie manager         — supported, but the headless-Linux CI box has no
//!              display, so this path CANNOT be exercised here. Correct-by-construction + verified
//!              by the user on mac/win.
//! `cookies_for_url` only returns http/https cookies (not tauri://), hence https://github.com.
//! HttpOnly cookies (user_session is HttpOnly) ARE included (it reads the platform cookie store,
//! not document.cookie).
//! =======================================================================================

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use super::{Result, ServiceError};

/// Browser-like UA used on every github.com request (mirrors gh-image's constant). GitHub's
/// upload endpoints are picky about a plausible browser UA on cookie-authenticated requests.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/// Persisted store file (shared with settings.rs and the JS-side plugin-store name).
const STORE_FILE: &str = "settings.json";
/// Store key holding the multi-account array (`[{ login, session }]`).
const KEY_ACCOUNTS: &str = "githubAccounts";
/// Legacy single-session keys (pre-multi-account); migrated on first load, then cleared.
const KEY_SESSION: &str = "githubUserSession";
const KEY_LOGIN: &str = "githubLogin";
/// The login webview window label.
const LOGIN_LABEL: &str = "github-login";

/// One stored GitHub account: the login handle (also its id) + its session cookie value.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
    login: String,
    session: String,
}

/// Reported to the frontend (serde camelCase → { id, login }); never carries the session value.
/// `id` == `login` (a github handle is unique and stable enough to key on).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub login: String,
}

impl From<&StoredAccount> for AccountInfo {
    fn from(a: &StoredAccount) -> Self {
        AccountInfo { id: a.login.clone(), login: a.login.clone() }
    }
}

// ---- persistence -------------------------------------------------------------

fn load_accounts<R: Runtime>(app: &AppHandle<R>) -> Vec<StoredAccount> {
    let Ok(store) = app.store(STORE_FILE) else {
        return Vec::new();
    };
    // Preferred: the multi-account array.
    if let Some(v) = store.get(KEY_ACCOUNTS) {
        if let Ok(list) = serde_json::from_value::<Vec<StoredAccount>>(v) {
            return list;
        }
    }
    // Migrate a legacy single session (pre-multi-account) into one account.
    let session = store.get(KEY_SESSION).and_then(|v| v.as_str().map(str::to_string));
    let login = store
        .get(KEY_LOGIN)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    if let Some(session) = session {
        if !session.is_empty() && !login.is_empty() {
            let list = vec![StoredAccount { login, session }];
            save_accounts(app, &list);
            return list;
        }
    }
    Vec::new()
}

fn save_accounts<R: Runtime>(app: &AppHandle<R>, list: &[StoredAccount]) {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Ok(v) = serde_json::to_value(list) {
            store.set(KEY_ACCOUNTS, v);
        }
        // We do NOT delete the legacy single-session keys: once `githubAccounts` exists,
        // load_accounts() reads only that, so the legacy keys are inert (avoids depending on a
        // store delete() API and can't re-migrate after the user signs all accounts out).
        let _ = store.save();
    }
}

/// All signed-in accounts (no session values) for the Settings UI.
pub fn list_accounts<R: Runtime>(app: &AppHandle<R>) -> Vec<AccountInfo> {
    load_accounts(app).iter().map(AccountInfo::from).collect()
}

/// The session cookie value for a given account id (== login). `None` ⇒ unknown/signed out.
/// When `id` is empty and exactly one account exists, fall back to it (single-account convenience
/// + back-compat for workspaces created before the account binding existed).
pub fn session_for<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<String> {
    let list = load_accounts(app);
    if id.is_empty() {
        return if list.len() == 1 { Some(list[0].session.clone()) } else { None };
    }
    list.into_iter().find(|a| a.login == id).map(|a| a.session)
}

/// Build the `Cookie:` header GitHub's CSRF check requires: BOTH `user_session` AND
/// `__Host-user_session_same_site`, carrying the SAME value (gh-image synthesizes the pair).
pub fn cookie_header(session_value: &str) -> String {
    format!("user_session={session_value}; __Host-user_session_same_site={session_value}")
}

// ---- cookie read (mac/win verification point — see module header) ------------

/// Read the `user_session` cookie value from the webview's platform cookie store for
/// https://github.com. Returns None if absent (signed out) or unsupported on this platform.
fn read_user_session<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let win = app
        .get_webview_window(LOGIN_LABEL)
        .or_else(|| app.get_webview_window("main"))?;
    let url = "https://github.com".parse().ok()?;
    let cookies = win.cookies_for_url(url).ok()?;
    cookies
        .into_iter()
        .find(|c| c.name() == "user_session")
        .map(|c| c.value().to_string())
}

// ---- login flow --------------------------------------------------------------

/// Open the login webview, wait for a `user_session` cookie, resolve the login, and UPSERT it as
/// an account (keyed by login). Returns the account. If the user is already signed into
/// github.com, GitHub's login page offers "sign in to a different account" so a second identity
/// can be added. Async (Tauri requires async for the cookie read on Windows — see module header).
pub async fn login<R: Runtime>(app: &AppHandle<R>) -> Result<AccountInfo> {
    open_login_window(app)?;

    // Poll for up to ~3 minutes (covers email + 2FA). Re-read the cookie each tick; the user
    // switching accounts inside the webview simply changes which session we capture.
    for _ in 0..360 {
        if app.get_webview_window(LOGIN_LABEL).is_none() {
            break; // user closed the window
        }
        if let Some(value) = read_user_session(app) {
            if let Some(login) = resolve_login(app, &value).await.filter(|s| !s.is_empty()) {
                let info = upsert_account(app, &login, &value);
                if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
                    let _ = win.close();
                }
                return Ok(info);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // One final read (e.g. the window just closed right after sign-in).
    if let Some(value) = read_user_session(app) {
        if let Some(login) = resolve_login(app, &value).await.filter(|s| !s.is_empty()) {
            return Ok(upsert_account(app, &login, &value));
        }
    }
    Err(ServiceError::Other(
        "No GitHub session captured — sign-in was not completed.".into(),
    ))
}

/// Insert or update an account by login, persisting its latest session cookie.
fn upsert_account<R: Runtime>(app: &AppHandle<R>, login: &str, session: &str) -> AccountInfo {
    let mut list = load_accounts(app);
    match list.iter_mut().find(|a| a.login == login) {
        Some(a) => a.session = session.to_string(),
        None => list.push(StoredAccount {
            login: login.to_string(),
            session: session.to_string(),
        }),
    }
    save_accounts(app, &list);
    AccountInfo { id: login.to_string(), login: login.to_string() }
}

/// Remove an account by id (== login). No-op if unknown.
pub fn logout<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let mut list = load_accounts(app);
    list.retain(|a| a.login != id);
    save_accounts(app, &list);
}

fn open_login_window<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // Load github.com/login directly. The user signs in there (or uses "sign in to a different
    // account" to add another); the resulting session cookie lands in the app's cookie store,
    // which read_user_session() then reads.
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

// ---- login resolution --------------------------------------------------------

/// Confirm the session cookie is live and learn the login: fetch github.com and scrape the
/// `<meta name="user-login" content="...">` tag GitHub renders for signed-in users. Returns None
/// on network error or signed-out HTML.
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
/// request sets the Cookie header explicitly (the S3 step must send NO cookies — see
/// github_upload.rs).
pub fn github_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60))
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

    #[test]
    fn account_info_from_stored_uses_login_as_id() {
        let a = StoredAccount { login: "octocat".into(), session: "s".into() };
        let info = AccountInfo::from(&a);
        assert_eq!(info.id, "octocat");
        assert_eq!(info.login, "octocat");
    }
}
