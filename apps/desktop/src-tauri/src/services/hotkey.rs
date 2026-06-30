//! Global capture hotkey management.
//!
//! Phase 3 keeps an in-process record of the active accelerator and registers
//! it through `tauri-plugin-global-shortcut`. Phase 4 persists the chosen
//! accelerator via `tauri-plugin-store` and adds the on-screen recorder.

use super::{Result, ServiceError};
use std::sync::{OnceLock, RwLock};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Default capture chord. CommandOrControl maps to ⌘ on macOS, Ctrl elsewhere.
const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+2";

fn current_cell() -> &'static RwLock<String> {
    static CELL: OnceLock<RwLock<String>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(DEFAULT_HOTKEY.to_string()))
}

/// The currently registered accelerator (e.g. "CommandOrControl+Shift+2").
pub fn current<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> String {
    current_cell().read().map(|g| g.clone()).unwrap_or_default()
}

/// Register the saved (or default) accelerator at startup. Best-effort: a
/// failure (e.g. native Wayland, or the chord already taken) is non-fatal.
pub fn register_saved<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // TODO(Phase 4): read the persisted accelerator from the store first.
    let accel = current(app);
    let _ = app.global_shortcut().register(accel.as_str());
}

/// Re-register the global shortcut, unregistering the previous one.
pub fn reregister<R: tauri::Runtime>(app: &tauri::AppHandle<R>, accelerator: &str) -> Result<()> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(accelerator)
        .map_err(|e| ServiceError::Hotkey(e.to_string()))?;
    if let Ok(mut g) = current_cell().write() {
        *g = accelerator.to_string();
    }
    // TODO(Phase 4): persist `accelerator` via tauri-plugin-store.
    Ok(())
}
