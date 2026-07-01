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
/// Key holding the whole webview-side `Config` object (see packages/core
/// storage.ts `CONFIG_KEY`). Read here only to honor `shortcutEnabled`.
const KEY_CONFIG: &str = "config";

/// Read the persisted capture accelerator, if any. `None` => use the default.
pub fn capture_hotkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(KEY_HOTKEY).and_then(|v| v.as_str().map(str::to_string))
}

/// The raw shared `Config.shortcutEnabled` flag, if persisted (under the
/// `config` key by packages/core storage.ts). `None` when no config is stored
/// yet or the field is absent/non-bool.
///
/// DIVERGENCE from the browser extension (see `hotkey::register_saved` for how
/// this is applied): the extension's `DEFAULT_CONFIG` sets
/// `shortcutEnabled: false` (opt-in) and gates its command on it. The DESKTOP
/// treats the global hotkey as its PRIMARY surface and has NO enable/disable
/// toggle in Settings — only rebind/reset — so it never persists a meaningful
/// `true`. Honoring the shared `false` default literally would kill the hotkey
/// for every desktop user the instant the webview first writes config. This
/// getter exposes the flag so `register_saved` can apply the desktop policy
/// (on-by-default) without lying about the stored value.
pub fn shortcut_enabled<R: Runtime>(app: &AppHandle<R>) -> Option<bool> {
    let store = app.store(STORE_FILE).ok()?;
    let config = store.get(KEY_CONFIG)?;
    config.get("shortcutEnabled").and_then(|v| v.as_bool())
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
