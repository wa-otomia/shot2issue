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

/// The currently-registered accelerator, or an EMPTY string when nothing is
/// registered right now (Wayland, a failed rebind that couldn't be rolled back,
/// or `shortcutEnabled == false`). Surfaced to the Settings UI, which must be
/// able to tell "unregistered" apart from "the default is live" — so we do NOT
/// paper over `None` with the default here.
pub fn current() -> String {
    CURRENT.lock().unwrap().clone().unwrap_or_default()
}

/// Register the persisted (or default) accelerator at startup. Best-effort and
/// SELF-HEALING: if the stored chord fails (taken / transient), fall back to the
/// default so the app still has a working hotkey. MUST run after the event loop
/// is live (see lib.rs — spawned off the main thread), never inside setup().
pub fn register_saved<R: Runtime>(app: &AppHandle<R>) {
    // Consult the shared `Config.shortcutEnabled` flag. DIVERGENCE (documented in
    // settings::shortcut_enabled): the desktop treats the global hotkey as its
    // primary surface and has no enable/disable toggle, and the shared
    // DEFAULT_CONFIG persists `shortcutEnabled: false`. So we do NOT skip on the
    // bare shared default — that would kill the hotkey for every desktop user.
    // We only honor an explicit opt-out, which the desktop cannot currently set;
    // if a desktop toggle ever lands, flip the check below to gate on it. For now
    // this just surfaces the state and always registers (desktop default: on).
    match settings::shortcut_enabled(app) {
        Some(false) => {
            eprintln!(
                "note: shared Config.shortcutEnabled=false, but the desktop has no \
                 disable toggle and treats the hotkey as on-by-default; registering anyway"
            );
        }
        Some(true) | None => {}
    }
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

/// Wire ONE accelerator's callback into the plugin. Parses, then calls
/// `on_shortcut` (which returns Err on Wayland / genuine OS collision). Does NOT
/// touch `CURRENT`, `unregister_all`, or the persisted setting — the caller owns
/// that bookkeeping so it can roll back. Returns Err with the raw plugin message.
fn wire_shortcut<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<()> {
    // Parse first: an invalid accelerator must not disturb the live binding.
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| ServiceError::Other(format!("invalid accelerator: {accelerator}")))?;

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _sc, event| {
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
        })
}

/// (Re)register the global capture hotkey. Defensive + idempotent + NON-DESTRUCTIVE:
///   1. parse the NEW accelerator first (cheap; no OS call on failure),
///   2. remember the currently-live accelerator so a failed rebind can roll back,
///   3. clear ALL existing registrations so no ghost chord and no stale OS hold
///      of the same chord survives (fixes eventHotKeyExistsErr on rebind and on
///      retry-after-a-failed-first-attempt),
///   4. wire the NEW chord; on FAILURE re-wire the previous chord (best-effort)
///      and restore `CURRENT` so a bad rebind never leaves the user with no
///      working hotkey, THEN return the error,
///   5. on success record `CURRENT` + persist.
/// Returns Err on Wayland / parse failure / genuine OS collision — the raw
/// message is surfaced to the UI so a first-real-run failure is diagnosable.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<()> {
    let gs = app.global_shortcut();

    // Parse the NEW chord up front (no OS call): an invalid accelerator must not
    // disturb the live binding, so bail before clearing anything.
    let _: Shortcut = accelerator
        .parse()
        .map_err(|_| ServiceError::Other(format!("invalid accelerator: {accelerator}")))?;

    // Capture the previous accelerator BEFORE clearing so we can restore it if
    // the new chord fails to register.
    let previous = CURRENT.lock().unwrap().clone();

    // Clear EVERYTHING this app registered. This drops both the previous chord
    // and any stale registration of the incoming chord (e.g. a partial
    // registration from a failed prior attempt), so re-registering the same
    // chord can't hit Carbon's eventHotKeyExistsErr. Non-fatal on a fresh
    // process (nothing to clear). The app registers exactly one global shortcut.
    if let Err(e) = gs.unregister_all() {
        eprintln!("unregister_all before rebind failed (continuing): {e}");
    }
    *CURRENT.lock().unwrap() = None; // no longer reflects reality after the clear

    if let Err(e) = wire_shortcut(app, accelerator) {
        // Rollback: the new chord failed. Re-wire the previously-live chord
        // (best-effort) so we don't leave the user with a working binding
        // destroyed, then surface the original error.
        if let Some(prev) = previous {
            match wire_shortcut(app, &prev) {
                Ok(()) => {
                    *CURRENT.lock().unwrap() = Some(prev);
                }
                Err(e2) => {
                    eprintln!("rollback to previous hotkey '{prev}' failed: {e2}");
                }
            }
        }
        return Err(e);
    }

    *CURRENT.lock().unwrap() = Some(accelerator.to_string());
    settings::set_capture_hotkey(app, accelerator);
    Ok(())
}

/// Bring the hidden/minimized main window back to the foreground (show +
/// unminimize + focus). Mirrors `tray::reveal_main`; used on the macOS
/// Screen-Recording-denied path so the in-window banner is visible even when the
/// capture was fired by the global hotkey with the window hidden to the tray.
#[cfg(target_os = "macos")]
fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
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
/// callback or the tray menu — paths where the app's own window must NOT be
/// hidden first (the user pressed a global chord; the visible window, if any, is
/// legitimately part of the shot). Capture is CPU-bound + uses platform APIs, so
/// it runs on a blocking thread.
pub async fn trigger_capture<R: Runtime>(app: &AppHandle<R>) {
    trigger_capture_impl(app, false).await;
}

/// The "Capture now" button path (the `trigger_capture` command). This is an
/// explicit foreground request from inside the app, so the app's own main window
/// would otherwise land in the shot. Hide it before the grab and restore it
/// after, so the frozen frame shows the user's actual work, not shot2issue.
pub async fn trigger_capture_foreground<R: Runtime>(app: &AppHandle<R>) {
    trigger_capture_impl(app, true).await;
}

async fn trigger_capture_impl<R: Runtime>(app: &AppHandle<R>, hide_self: bool) {
    // For the explicit button path, hide our own window so it isn't part of the
    // capture. Remember whether it was visible so we only re-show what we hid.
    let hid_main = hide_self && hide_main_for_capture(app);

    let (cx, cy) = cursor_global(app);
    let shot = tauri::async_runtime::spawn_blocking(move || capture::capture_at(cx, cy)).await;

    // Restore our window (if we hid it) as soon as the pixels are grabbed, before
    // presenting the overlay / any early return below.
    if hid_main {
        reveal_main_after_capture(app);
    }

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
                // The window may be hidden to the tray (this path can fire from
                // the global hotkey), so the emitted event's in-window banner
                // would be invisible. Reveal + focus the main window so HomeView's
                // "needs Screen Recording" banner is actually seen. (No
                // tauri-plugin-notification dependency, so we surface it in-app.)
                reveal_main(app);
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

/// Hide the main window before an in-app "Capture now" so it isn't in the shot.
/// Returns true only if the window was visible and we hid it (so the caller
/// re-shows exactly what it hid). Gives the compositor a brief moment to actually
/// clear the window off-screen before the grab.
fn hide_main_for_capture<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    // Only hide (and later restore) a currently-visible window.
    if !win.is_visible().unwrap_or(false) {
        return false;
    }
    if win.hide().is_err() {
        return false;
    }
    // Let the window server actually composite the window away before we grab
    // the frame; without this the shot can still contain a ghost of our window.
    std::thread::sleep(std::time::Duration::from_millis(120));
    true
}

/// Re-show the main window after an in-app "Capture now" grab. Only called when
/// `hide_main_for_capture` reported it hid the window.
fn reveal_main_after_capture<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}
