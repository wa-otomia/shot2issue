use crate::services::{capture, hotkey, updates};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Capture(String),
    #[error("{0}")]
    Other(String),
}
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
pub type Result<T> = std::result::Result<T, AppError>;

// ---------- Capture ----------
#[tauri::command]
pub async fn capture_screen_under_cursor() -> Result<capture::CaptureResult> {
    capture::screen_under_cursor()
}
#[tauri::command]
pub async fn list_displays() -> Result<Vec<capture::Display>> {
    capture::list_displays()
}
#[tauri::command]
pub async fn list_windows() -> Result<Vec<capture::WindowInfo>> {
    capture::list_windows()
}
#[tauri::command]
pub async fn capture_window(window_id: u32) -> Result<capture::CaptureResult> {
    capture::capture_window(window_id)
}
#[tauri::command]
pub fn mac_screen_recording_authorized() -> bool {
    capture::mac_screen_recording_authorized()
}

// ---------- HUD overlay ----------
#[tauri::command]
pub fn open_overlay(app: tauri::AppHandle, display_id: u32) -> Result<bool> {
    let d = capture::find_display(display_id)
        .ok_or_else(|| AppError::Capture("display not found".into()))?;
    Ok(crate::open_overlay(&app, &d))
}
#[tauri::command]
pub fn close_overlay(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.close();
    }
}

// ---------- Hotkey ----------
#[tauri::command]
pub fn get_hotkey(app: tauri::AppHandle) -> String {
    hotkey::current(&app)
}
#[tauri::command]
pub fn set_hotkey(app: tauri::AppHandle, accelerator: String) -> Result<()> {
    hotkey::reregister(&app, &accelerator).map_err(|e| AppError::Other(e.to_string()))
}

// ---------- Updates / windows (copied from curvault) ----------
#[tauri::command]
pub async fn check_for_updates() -> Result<updates::UpdateInfo> {
    updates::check().await.map_err(|e| AppError::Other(e.to_string()))
}
#[tauri::command]
pub fn open_updater_window(app: tauri::AppHandle) {
    crate::open_updater(&app);
}
#[tauri::command]
pub fn open_about_window(app: tauri::AppHandle) {
    crate::open_about(&app);
}
