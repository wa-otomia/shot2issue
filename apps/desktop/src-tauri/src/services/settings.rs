//! Persisted settings backed by tauri-plugin-store. Phase 4 only needs the
//! capture hotkey accelerator; later phases (accounts, capture mode, AI) extend
//! the same store file.
//!
//! All functions are best-effort: a store read/write failure degrades to the
//! in-memory default rather than blocking capture. Keep signatures stable so
//! later phases can layer more keys without touching callers.

use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

/// Store file (created on first write under the app's data dir).
const STORE_FILE: &str = "settings.json";
/// Key holding the global capture accelerator string.
const KEY_HOTKEY: &str = "captureHotkey";

/// Read the persisted capture accelerator, if any. `None` => use the default.
pub fn capture_hotkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(KEY_HOTKEY).and_then(|v| v.as_str().map(str::to_string))
}

/// Persist the capture accelerator. Best-effort; logs on failure.
pub fn set_capture_hotkey<R: Runtime>(app: &AppHandle<R>, accelerator: &str) {
    match app.store(STORE_FILE) {
        Ok(store) => {
            store.set(KEY_HOTKEY, accelerator);
            if let Err(e) = store.save() {
                eprintln!("settings: failed to persist hotkey: {e}");
            }
        }
        Err(e) => eprintln!("settings: failed to open store: {e}"),
    }
}
