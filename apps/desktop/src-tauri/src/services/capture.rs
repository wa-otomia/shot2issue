//! Screen capture service.
//!
//! Phase 3 (this commit) defines the type surface + the wiring the shell needs
//! (`is_wayland`, `begin_capture_flow`) and stubs the actual grab/enumerate
//! paths with `todo!()`. Phase 4 fills them in using `xcap` (Win/mac/X11) with
//! an XDG-portal fallback on Wayland, then `image` -> `base64` data URLs.

use crate::commands::AppError;
use serde::Serialize;

/// A connected display. Mirrors `DisplayInfo` in src/lib/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub is_primary: bool,
}

/// An enumerated top-level window. Mirrors `WindowInfo` in src/lib/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A finished capture handed to the annotate stage. Mirrors `CaptureResult`
/// in src/lib/api.ts: `png_data_url` is a `data:image/png;base64,…` string.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub png_data_url: String,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub source_display_id: Option<u32>,
}

type Result<T> = std::result::Result<T, AppError>;

/// True when running under a native Wayland session (where xcap cannot grab
/// and Tauri cannot freely position the always-on-top HUD). Used by the shell
/// to fall back to an in-window crop. Best-effort env probe.
pub fn is_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return true;
        }
        return std::env::var("XDG_SESSION_TYPE")
            .map(|s| s.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Entry point invoked from the global-shortcut handler (Rust-driven capture).
/// Phase 4: grab the screen under the cursor, freeze it, open the HUD seeded
/// with the frame. For now this is a no-op placeholder so the shell links.
pub fn begin_capture_flow<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {
    // TODO(Phase 4): screen_under_cursor() -> open_overlay() -> seed frame.
}

// ---------- Stubbed grab/enumerate paths (Phase 4) ----------

pub fn screen_under_cursor() -> Result<CaptureResult> {
    todo!("Phase 4: grab the display under the cursor via xcap, encode to PNG data URL")
}

pub fn list_displays() -> Result<Vec<Display>> {
    todo!("Phase 4: enumerate monitors via xcap::Monitor::all()")
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    todo!("Phase 4: enumerate top-level windows via xcap::Window::all()")
}

pub fn capture_window(_window_id: u32) -> Result<CaptureResult> {
    todo!("Phase 4: capture a single window via xcap and encode to PNG data URL")
}

pub fn find_display(_display_id: u32) -> Option<Display> {
    // TODO(Phase 4): look up the enumerated display by id.
    None
}

/// macOS: is Screen Recording (TCC) authorized? Other platforms always true.
#[cfg(target_os = "macos")]
pub fn mac_screen_recording_authorized() -> bool {
    // TODO(Phase 4): probe via core-graphics CGPreflightScreenCaptureAccess.
    let _ = core_graphics::display::CGDisplay::main();
    true
}

#[cfg(not(target_os = "macos"))]
pub fn mac_screen_recording_authorized() -> bool {
    true
}
