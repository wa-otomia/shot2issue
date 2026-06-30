//! Global capture hotkey: register a user-rebindable accelerator that fires
//! while the app is backgrounded, then grab the monitor under the cursor and
//! open the crop overlay.
//!
//! Platform reality: tauri-plugin-global-shortcut works on Windows, macOS
//! (Carbon RegisterEventHotKey — no Accessibility grant needed) and Linux/X11.
//! On native Wayland the plugin cannot grab a global key; `register` returns an
//! error which we surface so the UI can tell the user to use the tray menu /
//! "Capture now" button instead.

use std::sync::Mutex;

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::{Result, ServiceError};
use crate::services::{capture, overlay, settings};

/// The currently-registered accelerator string, so a rebind can unregister the
/// previous chord first. `None` until the first successful registration.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// Default capture chord per OS. Chosen to avoid the OS screenshot tools:
///   - macOS reserves Cmd+Shift+3/4/5 for its built-in screenshot/recording.
///   - Windows uses Win+Shift+S (Snip) and PrintScreen.
///   - GNOME/KDE bind PrintScreen + Shift/Ctrl+PrintScreen.
/// `CmdOrCtrl+Shift+2` (⌘⇧2 on macOS, Ctrl+Shift+2 elsewhere) collides with
/// none of those. `CmdOrCtrl` is the plugin's portable modifier token.
pub fn default_accelerator() -> &'static str {
    "CommandOrControl+Shift+2"
}

/// The currently-registered accelerator (falls back to the default if a rebind
/// hasn't happened yet this run). Surfaced to the Settings UI.
pub fn current() -> String {
    CURRENT
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| default_accelerator().to_string())
}

/// Register the persisted (or default) accelerator at startup. Best-effort: a
/// failure (native Wayland, or the chord already taken) is non-fatal — the tray
/// "Capture now" item still works. The chosen value is persisted so a later
/// run reuses it.
pub fn register_saved<R: Runtime>(app: &AppHandle<R>) {
    let accel = settings::capture_hotkey(app).unwrap_or_else(|| default_accelerator().to_string());
    if let Err(e) = register(app, &accel) {
        eprintln!("global hotkey not registered: {e}");
    }
}

/// (Re)register the global capture hotkey, unregistering any previous binding.
/// Persists the new accelerator. Returns Err on Wayland / parse failure / when
/// the chord is taken, so the UI can show the reason.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<()> {
    let gs = app.global_shortcut();

    // Drop the old binding so a rebind doesn't leave a ghost shortcut.
    if let Some(prev) = CURRENT.lock().unwrap().take() {
        if let Ok(s) = prev.parse::<Shortcut>() {
            let _ = gs.unregister(s);
        }
    }

    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| ServiceError::Other(format!("invalid accelerator: {accelerator}")))?;

    let handle = app.clone();
    gs.on_shortcut(shortcut, move |_app, _sc, event| {
        // Fire on key-DOWN only (avoid a second trigger on release).
        if event.state() == ShortcutState::Pressed {
            let h = handle.clone();
            // Spawn so the plugin callback returns immediately; the capture +
            // overlay creation happen off the hotkey thread.
            tauri::async_runtime::spawn(async move {
                trigger_capture(&h).await;
            });
        }
    })
    .map_err(|e| {
        ServiceError::Hotkey(format!(
            "register hotkey: {e} (native Wayland is unsupported — use the tray menu)"
        ))
    })?;

    *CURRENT.lock().unwrap() = Some(accelerator.to_string());
    let _ = settings::set_capture_hotkey(app, accelerator);
    Ok(())
}

/// Read the OS pointer position in GLOBAL device px. Tauri's `cursor_position`
/// lives on the app handle and is already in the global space xcap's
/// `Monitor::from_point` expects.
fn cursor_global<R: Runtime>(app: &AppHandle<R>) -> (i32, i32) {
    match app.cursor_position() {
        Ok(p) => (p.x.round() as i32, p.y.round() as i32),
        Err(_) => (0, 0),
    }
}

/// The full hotkey -> capture -> overlay flow. Callable from the hotkey
/// callback, the tray menu, or the "Capture now" button (via `trigger_capture`
/// command). Capture is CPU-bound + uses platform APIs, so it runs on a
/// blocking thread.
pub async fn trigger_capture<R: Runtime>(app: &AppHandle<R>) {
    let (cx, cy) = cursor_global(app);
    let shot = tauri::async_runtime::spawn_blocking(move || capture::capture_at(cx, cy)).await;
    match shot {
        Ok(Ok(shot)) => {
            // macOS: a freshly captured all-black frame almost always means
            // Screen Recording (TCC) was denied. Route the user to the grant +
            // restart flow rather than opening an empty overlay.
            #[cfg(target_os = "macos")]
            if capture::last_frame_is_all_black() && !capture::mac_screen_recording_authorized() {
                let _ = capture::mac_request_screen_recording();
                use tauri::Emitter;
                let _ = app.emit("capture://needs-screen-recording", ());
                capture::clear_last_frame();
                return;
            }
            if let Err(e) = overlay::present(app, shot) {
                eprintln!("overlay present failed: {e}");
            }
        }
        Ok(Err(e)) => eprintln!("capture failed: {e}"),
        Err(e) => eprintln!("capture task panicked: {e}"),
    }
}
