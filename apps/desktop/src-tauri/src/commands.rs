//! Tauri command surface. Renderer `invoke()` calls enter here; every command
//! is a thin wrapper delegating to a service (curvault convention). Capture /
//! window / crop work runs on a blocking thread (xcap uses platform APIs and is
//! CPU-bound). All return `services::Result`, serialized as a string error.

use tauri::AppHandle;

use crate::services::{capture, editor_stage, hotkey, overlay, updates, ServiceError};
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

/// Manual trigger (tray menu / "Capture now" button / test) — same path as the
/// global hotkey: grab the monitor under the cursor, then present the overlay.
#[tauri::command]
pub async fn trigger_capture(app: AppHandle) -> Result<()> {
    hotkey::trigger_capture(&app).await;
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
#[tauri::command]
pub async fn crop_region(x: f64, y: f64, width: f64, height: f64) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || capture::crop_last(x, y, width, height))
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
pub fn overlay_set_click_through(app: AppHandle, ignore: bool) -> Result<()> {
    overlay::set_click_through(&app, ignore)
}

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
