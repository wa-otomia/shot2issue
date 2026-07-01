//! GitHub via github.com WEB SESSION cookies — no OAuth, no PAT. Supports MULTIPLE accounts.
//!
//! USER DECISION: GitHub uses COOKIES for EVERYTHING. A built-in GitHub-login webview obtains a
//! `user_session` cookie; that session drives BOTH image upload (user-attachments, see
//! github_upload.rs) AND issue creation (see github_issue.rs). Rationale: the user-attachments
//! upload endpoints are web-session-only — OAuth/PAT tokens are rejected there — so
//! cookie-for-everything avoids running two auth systems.
//!
//! MULTI-ACCOUNT: GitHub is a first-class account KIND. Each signed-in account is stored as
//! { id, login, session } in the app store (key `githubAccounts`), keyed by a FRONTEND-provided
//! account id (NOT the github login — the login is a mutable handle, so coupling identity to it
//! is wrong). `login` is the resolved github handle, kept for display only. The upload/issue
//! commands take a session chosen by account id, so different workspaces can file as different
//! accounts.
//!
//! ADDING A SECOND ACCOUNT: the login webview shares one live github.com session, so if we just
//! reopened it the user would still be signed into the FIRST account and we'd re-capture the same
//! identity. So `login()` first CLEARS the webview's browsing data (cookies), which signs
//! github.com out, then navigates to the login page — the user starts signed out and can pick a
//! DIFFERENT identity. This does NOT affect already-stored accounts: uploads/issues send the
//! stored cookie string via reqwest (see github_client / cookie_header), not the webview jar.
//!
//! ============================== mac/win VERIFICATION POINT ==============================
//! Reading the cookie uses Tauri 2's `WebviewWindow::cookies_for_url()` (tauri 2.4.0+; this app
//! pins 2.11.x), backed by wry's cookie getters:
//!   - macOS:   WKHTTPCookieStore (WKWebView)   — supported. WKWebsiteDataStore is process-shared,
//!              so clearing browsing data on ANY window signs github.com out everywhere.
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
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use super::{Result, ServiceError};

/// Browser-like UA used on every github.com request (mirrors gh-image's constant). GitHub's
/// upload endpoints are picky about a plausible browser UA on cookie-authenticated requests.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/// Persisted store file (shared with settings.rs and the JS-side plugin-store name).
const STORE_FILE: &str = "settings.json";
/// Store key holding the multi-account array (`[{ id, login, session }]`).
const KEY_ACCOUNTS: &str = "githubAccounts";
/// Legacy single-session keys (pre-multi-account); migrated on first load, then inert.
const KEY_SESSION: &str = "githubUserSession";
const KEY_LOGIN: &str = "githubLogin";
/// The login webview window label.
const LOGIN_LABEL: &str = "github-login";
/// Where the login webview lands after we clear its session.
const LOGIN_URL: &str = "https://github.com/login";

/// One stored GitHub account: the frontend account id + resolved login handle + session cookie.
/// `id` is the identity key (stable, frontend-provided); `login` is display-only (mutable handle).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
    id: String,
    login: String,
    session: String,
}

/// Reported to the frontend (serde camelCase → { id, login }); never carries the session value.
/// `id` is the account id (for migrated records id == login; for new records it is a
/// frontend-generated account id). `login` is the resolved github handle (display only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub login: String,
}

impl From<&StoredAccount> for AccountInfo {
    fn from(a: &StoredAccount) -> Self {
        AccountInfo { id: a.id.clone(), login: a.login.clone() }
    }
}

/// Legacy array record shape (pre-account-id): `{ login, session }` with no `id`. Migrated by
/// treating id == login so existing workspace bindings (which stored the login as the id) resolve.
#[derive(Debug, Clone, Deserialize)]
struct LegacyAccount {
    login: String,
    session: String,
}

// ---- persistence -------------------------------------------------------------

fn load_accounts<R: Runtime>(app: &AppHandle<R>) -> Vec<StoredAccount> {
    let Ok(store) = app.store(STORE_FILE) else {
        return Vec::new();
    };
    // Preferred: the multi-account array, now shaped `{ id, login, session }`.
    if let Some(v) = store.get(KEY_ACCOUNTS) {
        if let Ok(list) = serde_json::from_value::<Vec<StoredAccount>>(v.clone()) {
            return list;
        }
        // Migrate legacy array records `{ login, session }` (no id) → id == login.
        if let Ok(legacy) = serde_json::from_value::<Vec<LegacyAccount>>(v) {
            let list: Vec<StoredAccount> = legacy
                .into_iter()
                .map(|a| StoredAccount { id: a.login.clone(), login: a.login, session: a.session })
                .collect();
            save_accounts(app, &list);
            return list;
        }
    }
    // Migrate a legacy single session (pre-multi-account) into one account: id == login.
    let session = store.get(KEY_SESSION).and_then(|v| v.as_str().map(str::to_string));
    let login = store
        .get(KEY_LOGIN)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    if let Some(session) = session {
        if !session.is_empty() && !login.is_empty() {
            let list = vec![StoredAccount { id: login.clone(), login, session }];
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

/// The session cookie value for a given account id. `None` ⇒ unknown/signed out.
/// When `id` is empty and exactly one account exists, fall back to it (single-account convenience
/// + back-compat for workspaces created before the account binding existed).
pub fn session_for<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<String> {
    let list = load_accounts(app);
    if id.is_empty() {
        return if list.len() == 1 { Some(list[0].session.clone()) } else { None };
    }
    list.into_iter().find(|a| a.id == id).map(|a| a.session)
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

/// Sign a NEW identity into the account slot `account_id`: clear the login webview so github.com
/// starts signed OUT (so a DIFFERENT identity can be added — otherwise the live session would just
/// re-capture the first account), navigate to the login page, wait for a fresh `user_session`
/// cookie, resolve the login handle, and UPSERT { id: account_id, login, session } keyed by
/// account_id. Returns { id: account_id, login }. Async (Tauri requires async for the cookie read
/// on Windows — see module header).
pub async fn login<R: Runtime>(app: &AppHandle<R>, account_id: &str) -> Result<AccountInfo> {
    start_signed_out(app).await?;

    // Poll for up to ~3 minutes (covers email + 2FA). Re-read the cookie each tick; the user
    // switching accounts inside the webview simply changes which session we capture.
    for _ in 0..360 {
        if app.get_webview_window(LOGIN_LABEL).is_none() {
            break; // user closed the window
        }
        if let Some(value) = read_user_session(app) {
            if let Some(login) = resolve_login(app, &value).await.filter(|s| !s.is_empty()) {
                let info = upsert_account(app, account_id, &login, &value);
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
            return Ok(upsert_account(app, account_id, &login, &value));
        }
    }
    Err(ServiceError::Other(
        "No GitHub session captured — sign-in was not completed.".into(),
    ))
}

/// Insert or update an account by its account id, persisting its latest login + session cookie.
fn upsert_account<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    login: &str,
    session: &str,
) -> AccountInfo {
    let mut list = load_accounts(app);
    match list.iter_mut().find(|a| a.id == id) {
        Some(a) => {
            a.login = login.to_string();
            a.session = session.to_string();
        }
        None => list.push(StoredAccount {
            id: id.to_string(),
            login: login.to_string(),
            session: session.to_string(),
        }),
    }
    save_accounts(app, &list);
    AccountInfo { id: id.to_string(), login: login.to_string() }
}

/// Remove an account by its account id. No-op if unknown.
pub fn logout<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let mut list = load_accounts(app);
    list.retain(|a| a.id != id);
    save_accounts(app, &list);
}

/// Prepare the login webview so the user starts SIGNED OUT of github.com, then land it on the
/// login page. Clearing browsing data drops the live `user_session` cookie (WKWebsiteDataStore is
/// process-shared on macOS, so this signs github.com out for the whole app webview), letting the
/// user add a DIFFERENT identity. Stored per-account sessions are untouched (uploads use the
/// stored cookie via reqwest, not this webview jar).
async fn start_signed_out<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let login_url: tauri::Url = LOGIN_URL
        .parse()
        .map_err(|e| ServiceError::Other(format!("login url: {e}")))?;

    // Reuse the existing login window if present; else create one (initially pointed at the login
    // URL — we still clear + navigate below so a reopened window also starts signed out).
    let win = match app.get_webview_window(LOGIN_LABEL) {
        Some(win) => win,
        None => build_login_window(app, login_url.clone())?,
    };

    // Sign github.com out: clear cookies/storage for the webview. Clearing on any window drops the
    // process-shared github.com session (macOS WKWebsiteDataStore); the stored accounts are safe.
    clear_browsing_data(&win);

    // A brief pause lets the platform finish tearing down the cleared session before we reload
    // the login page against it (avoids racing the clear on some platforms).
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Land the (now signed-out) webview on the login page and bring it forward.
    let _ = win.navigate(login_url);
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Clear the webview's browsing data (cookies + storage). Tolerant of the (rare) error so a clear
/// failure can't abort sign-in — a failed clear just means the user may see the prior identity and
/// can use GitHub's own "sign in to a different account" affordance.
fn clear_browsing_data<R: Runtime>(win: &WebviewWindow<R>) {
    let _ = win.clear_all_browsing_data();
}

/// Build the login webview window pointed at github.com/login. The user signs in there (or, if a
/// prior clear didn't fully sign them out, uses "sign in to a different account"); the resulting
/// session cookie lands in the app's cookie store, which read_user_session() then reads.
fn build_login_window<R: Runtime>(
    app: &AppHandle<R>,
    url: tauri::Url,
) -> Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Sign in to GitHub")
        .inner_size(560.0, 720.0)
        .resizable(true)
        .center()
        .focused(true)
        .build()
        .map_err(|e| ServiceError::Other(format!("github login window: {e}")))
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
    fn account_info_carries_id_distinct_from_login() {
        // `id` is the (frontend) account id, NOT the login handle — a renamed github user keeps
        // the same account id, so the AccountInfo reports id and login independently.
        let a = StoredAccount {
            id: "acct_123".into(),
            login: "octocat".into(),
            session: "s".into(),
        };
        let info = AccountInfo::from(&a);
        assert_eq!(info.id, "acct_123");
        assert_eq!(info.login, "octocat");
    }

    #[test]
    fn account_info_from_migrated_record_has_id_equal_to_login() {
        // Migrated legacy records use id == login (so existing workspace bindings resolve).
        let a = StoredAccount {
            id: "octocat".into(),
            login: "octocat".into(),
            session: "s".into(),
        };
        let info = AccountInfo::from(&a);
        assert_eq!(info.id, "octocat");
        assert_eq!(info.login, "octocat");
    }
}
</content>
