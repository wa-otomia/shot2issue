//! Tauri command surface. Renderer `invoke()` calls enter here; every command
//! is a thin wrapper delegating to a service (curvault convention). Capture /
//! window / crop work runs on a blocking thread (xcap uses platform APIs and is
//! CPU-bound). All return `services::Result`, serialized as a string error.

use tauri::AppHandle;

use crate::services::{
    capture, editor_stage, github, github_issue, github_upload, hotkey, oauth_loopback, overlay,
    updates, ServiceError,
};
use crate::services::Result;

fn join_err(e: tauri::Error) -> ServiceError {
    ServiceError::Other(format!("task join: {e}"))
}

// ---------- Hotkey ----------

/// The built-in default chord (shown in Settings before a rebind).
#[tauri::command]
pub fn get_default_accelerator() -> String {
    hotkey::default_accelerator().to_string()
}

/// The currently-registered chord.
#[tauri::command]
pub fn get_hotkey() -> String {
    hotkey::current()
}

/// (Re)bind the global capture hotkey. Err on Wayland / parse failure /
/// chord-in-use — the renderer surfaces the reason.
#[tauri::command]
pub fn set_capture_hotkey(app: AppHandle, accelerator: String) -> Result<()> {
    hotkey::register(&app, &accelerator)
}

/// Manual "Capture now" button trigger — same capture path as the global hotkey,
/// but as an explicit in-app request it hides the app's own main window first so
/// shot2issue isn't part of the grab, then restores it.
#[tauri::command]
pub async fn trigger_capture(app: AppHandle) -> Result<()> {
    hotkey::trigger_capture_foreground(&app).await;
    Ok(())
}

// ---------- Capture ----------

fn cursor_xy(app: &AppHandle) -> (i32, i32) {
    app.cursor_position()
        .map(|p| (p.x.round() as i32, p.y.round() as i32))
        .unwrap_or((0, 0))
}

/// Capture the monitor under the cursor right now (foreground button path).
/// Returns the frozen `MonitorShot`; the overlay then pulls the same shot via
/// `get_overlay_shot`.
#[tauri::command]
pub async fn capture_current_monitor(app: AppHandle) -> Result<capture::MonitorShot> {
    let (x, y) = cursor_xy(&app);
    tauri::async_runtime::spawn_blocking(move || capture::screen_under_cursor(x, y))
        .await
        .map_err(join_err)?
}

/// List connected displays (used by a foreground display picker).
#[tauri::command]
pub async fn list_displays() -> Result<Vec<capture::Display>> {
    tauri::async_runtime::spawn_blocking(capture::list_displays)
        .await
        .map_err(join_err)?
}

/// Pull the frozen shot the overlay should paint (called once the overlay
/// webview mounts, and again on `overlay://refresh`).
#[tauri::command]
pub fn get_overlay_shot() -> Option<capture::MonitorShot> {
    overlay::take_pending_shot()
}

/// List top-level windows for window-pick.
#[tauri::command]
pub async fn list_windows() -> Result<Vec<capture::WindowInfo>> {
    tauri::async_runtime::spawn_blocking(capture::list_windows)
        .await
        .map_err(join_err)?
}

/// Capture one window to a tight PNG (window-pick confirm).
#[tauri::command]
pub async fn capture_window(id: u32) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || capture::capture_window(id))
        .await
        .map_err(join_err)?
}

/// Crop the frozen frame to a logical-px rect relative to the overlay client
/// area. Returns a tight base64 PNG.
///
/// `token` is the `MonitorShot.token` the overlay was handed; it lets the crop
/// reject a request against a frame a newer capture already replaced. It is
/// `Option` for wire-compat while the webview is threaded through to send it (an
/// old renderer omits it → best-effort crop of the current frame, today's
/// behavior); once the overlay always sends it, mismatches hard-error.
#[tauri::command]
pub async fn crop_region(
    token: Option<u64>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || match token {
        Some(t) => capture::crop_last(t, x, y, width, height),
        None => capture::crop_last_untokened(x, y, width, height),
    })
    .await
    .map_err(join_err)?
}

/// macOS: is Screen Recording (TCC) granted? Always true off macOS. The UI uses
/// this to guide the one-time grant + restart instead of capturing a black
/// frame.
#[tauri::command]
pub fn mac_screen_recording_authorized() -> bool {
    capture::mac_screen_recording_authorized()
}

// ---------- Overlay ----------

#[tauri::command]
pub fn overlay_dismiss(app: AppHandle) {
    overlay::dismiss(&app);
}

// ---------- Editor staging ----------

/// After a crop / window-pick, hand the PNG to the editor exactly like the
/// extension's `stageAndOpen`: stash the data URL + metadata and open (or
/// focus) the `editor` window.
#[tauri::command]
pub fn open_editor_with(app: AppHandle, png_base64: String) -> Result<()> {
    editor_stage::stage_and_open(&app, png_base64)
}

/// The editor view reads the staged shots on mount.
#[tauri::command]
pub fn get_pending_shots() -> Option<editor_stage::PendingShots> {
    editor_stage::get_pending_shots()
}

// ---------- Updates / windows (copied from curvault) ----------

#[tauri::command]
pub async fn check_for_updates() -> Result<updates::UpdateInfo> {
    updates::check().await
}

#[tauri::command]
pub fn open_updater_window(app: AppHandle) {
    crate::open_updater(&app);
}

#[tauri::command]
pub fn open_about_window(app: AppHandle) {
    crate::open_about(&app);
}

// ---------- Codex OAuth loopback (NOT GitHub) ----------

/// Bind 127.0.0.1:1455 and return the redirect URI to advertise. Called from
/// platform.ts's oauth.capture() before opening the authorize URL.
#[tauri::command]
pub async fn oauth_loopback_start() -> Result<String> {
    tauri::async_runtime::spawn_blocking(oauth_loopback::start)
        .await
        .map_err(join_err)?
}

/// Wait for the single OAuth callback connection and return the full callback
/// URL (with ?code=&state=). Runs on a blocking thread (it blocks on accept()).
#[tauri::command]
pub async fn oauth_loopback_wait() -> Result<String> {
    tauri::async_runtime::spawn_blocking(oauth_loopback::wait)
        .await
        .map_err(join_err)?
}

// ---------- GitHub (web-session cookie) ----------

/// Sign a GitHub identity into the given account slot: clear the login webview so github.com
/// starts signed OUT (letting a DIFFERENT identity be added), then capture the fresh user_session
/// cookie once the user signs in, upserting it keyed by `account_id`. GitHub is a first-class
/// account KIND, so the id is the frontend account id (NOT the mutable github login).
/// Async: the cookie read can deadlock in a sync command on Windows (see github.rs).
#[tauri::command]
pub async fn github_login(app: AppHandle, account_id: String) -> Result<github::AccountInfo> {
    github::login(&app, &account_id).await
}

/// List all signed-in GitHub accounts (id + login; no session values). One entry per stored
/// session, i.e. per signed-in account.
#[tauri::command]
pub fn github_accounts(app: AppHandle) -> Vec<github::AccountInfo> {
    github::list_accounts(&app)
}

/// Sign out one GitHub account by its account id, removing its stored session.
#[tauri::command]
pub fn github_logout(app: AppHandle, account_id: String) {
    github::logout(&app, &account_id);
}

/// Upload one screenshot (data: URL) via the gh-image protocol using the given
/// account's session; returns the user-attachments URL. Errors if that account
/// isn't signed in.
#[tauri::command]
pub async fn github_upload_image(
    app: AppHandle,
    account_id: String,
    owner: String,
    repo: String,
    data_url: String,
    filename: String,
) -> Result<String> {
    let session = github::session_for(&app, &account_id)
        .ok_or_else(|| ServiceError::Other("Not signed in to that GitHub account.".into()))?;
    github_upload::upload_image(&session, &owner, &repo, &data_url, &filename).await
}

/// Create an issue on github.com via the given account's session (body already
/// has any uploaded-image markdown embedded). Returns the created issue URL.
#[tauri::command]
pub async fn github_create_issue(
    app: AppHandle,
    account_id: String,
    owner: String,
    repo: String,
    title: String,
    body: String,
) -> Result<String> {
    let session = github::session_for(&app, &account_id)
        .ok_or_else(|| ServiceError::Other("Not signed in to that GitHub account.".into()))?;
    github_issue::create_issue(&session, &owner, &repo, &title, &body).await
}
