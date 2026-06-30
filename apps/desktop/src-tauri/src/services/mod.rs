pub mod capture;
pub mod editor_stage;
pub mod github;
pub mod github_issue;
pub mod github_upload;
pub mod hotkey;
pub mod oauth_loopback;
pub mod overlay;
pub mod settings;
pub mod tray;
pub mod updates;

use std::sync::OnceLock;
use tauri::AppHandle;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServiceError {
    // Reserved for the Phase 4 capture/store paths; not yet constructed.
    #[allow(dead_code)]
    #[error("capture error: {0}")]
    Capture(String),

    #[error("hotkey error: {0}")]
    Hotkey(String),

    #[allow(dead_code)]
    #[error("store error: {0}")]
    Store(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, ServiceError>;

/// Convert errors into a string-friendly form for Tauri command results.
impl serde::Serialize for ServiceError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// One-time injected app handle so service modules can `emit` / build windows
/// without taking AppHandle as a parameter on every helper (curvault pattern).
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn install_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// The injected handle, if `install_app_handle` has run. Used by services that
/// need to talk back to the app outside a command context (e.g. the hotkey
/// handler kicking off a capture).
#[allow(dead_code)]
pub fn app_handle() -> Option<&'static AppHandle> {
    APP_HANDLE.get()
}
