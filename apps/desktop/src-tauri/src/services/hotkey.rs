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

/// Register the persisted (or default) accelerator at startup. Best-effort and
/// SELF-HEALING: if the stored chord fails (taken / transient), fall back to the
/// default so the app still has a working hotkey. MUST run after the event loop
/// is live (see lib.rs — spawned off the main thread), never inside setup().
pub fn register_saved<R: Runtime>(app: &AppHandle<R>) {
    let stored = settings::capture_hotkey(app).unwrap_or_else(|| default_accelerator().to_string());
    if let Err(e) = register(app, &stored) {
        eprintln!("global hotkey '{stored}' not registered: {e}");
        // Self-heal: if a *custom* stored chord failed, try the default so the
        // user isn't left with no hotkey at all after a bad rebind.
        if stored != default_accelerator() {
            let def = default_accelerator();
            if let Err(e2) = register(app, def) {
                eprintln!("default hotkey '{def}' also failed: {e2}");
            } else {
                eprintln!("fell back to default hotkey '{def}'");
            }
        }
    }
}

/// (Re)register the global capture hotkey. Defensive + idempotent:
///   1. parse the NEW accelerator first (cheap; no OS call on failure),
///   2. clear ALL existing registrations so no ghost chord and no stale OS hold
///      of the same chord survives (fixes eventHotKeyExistsErr on rebind and on
///      retry-after-a-failed-first-attempt),
///   3. register fresh; on success record CURRENT + persist.
/// Returns Err on Wayland / parse failure / genuine OS collision — the raw
/// message is surfaced to the UI so a first-real-run failure is diagnosable.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<()> {
    let gs = app.global_shortcut();

    // Parse first: an invalid accelerator must not disturb the live binding.
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| ServiceError::Other(format!("invalid accelerator: {accelerator}")))?;

    // Clear EVERYTHING this app registered. This drops both the previous chord
    // and any stale registration of the incoming chord (e.g. a partial
    // registration from a failed prior attempt), so re-registering the same
    // chord can't hit Carbon's eventHotKeyExistsErr. Non-fatal on a fresh
    // process (nothing to clear). The app registers exactly one global shortcut.
    if let Err(e) = gs.unregister_all() {
        eprintln!("unregister_all before rebind failed (continuing): {e}");
    }
    *CURRENT.lock().unwrap() = None; // no longer reflects reality after the clear

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
            "register hotkey '{accelerator}': {e} \
             (chord may be in use by another app; native Wayland is unsupported — use the tray menu)"
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
