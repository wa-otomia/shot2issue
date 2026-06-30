//! Capture-overlay window lifecycle for region-crop and window-pick.
//!
//! Win/macOS/X11: a transparent, borderless, always-on-top, skip-taskbar
//! WebviewWindow is positioned exactly over the captured monitor. It paints the
//! frozen screenshot edge-to-edge and the user rubber-bands a rectangle on top.
//! macOS needs `macOSPrivateApi` (set in tauri.conf.json) for true window
//! transparency.
//!
//! Native Wayland: tao can't position a window or force always-on-top, so a
//! fullscreen always-on-top overlay is impossible. We degrade to a NORMAL,
//! centered, decorated window that shows the captured image and runs the exact
//! same crop UI against the static bitmap. The frontend already detects this
//! via `getOverlayShot` returning a shot it renders in-window.

use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

use super::{Result, ServiceError};
use crate::services::capture::{self, MonitorShot};

/// The shot the overlay is currently showing. The overlay webview fetches it
/// via `get_overlay_shot` once it mounts (avoids cramming a multi-MB base64 PNG
/// into the window URL). `take` returns + clears so the shot isn't re-served.
static PENDING_SHOT: Mutex<Option<MonitorShot>> = Mutex::new(None);

/// Hand the frozen shot to the overlay webview (consuming it).
pub fn take_pending_shot() -> Option<MonitorShot> {
    PENDING_SHOT.lock().unwrap().take()
}

/// Present the captured shot for cropping. Branches on platform; returns Ok on
/// success. On Wayland we route to the degraded in-window flow.
pub fn present<R: Runtime>(app: &AppHandle<R>, shot: MonitorShot) -> Result<()> {
    *PENDING_SHOT.lock().unwrap() = Some(shot);
    if capture::is_wayland() {
        present_windowed(app)
    } else {
        present_overlay(app)
    }
}

/// Win/macOS/X11: spawn (or reuse) the fullscreen transparent overlay placed
/// over the captured monitor.
fn present_overlay<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    // Read the geometry the new/existing overlay must cover, then release the
    // lock before touching windows (which may re-enter via commands).
    let (x, y, w, h) = {
        let guard = PENDING_SHOT.lock().unwrap();
        let shot = guard
            .as_ref()
            .ok_or_else(|| ServiceError::Other("no pending shot".into()))?;
        (shot.x as f64, shot.y as f64, shot.width as f64, shot.height as f64)
    };

    if let Some(win) = app.get_webview_window("overlay") {
        // Reuse: reposition over the (possibly different) monitor and re-emit so
        // the mounted React view re-pulls the new frozen frame.
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_always_on_top(true);
        let _ = win.set_ignore_cursor_events(false);
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("overlay://refresh", ());
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .title("shot2issue capture")
        .inner_size(w, h)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .transparent(true) // needs macOSPrivateApi on macOS
        .always_on_top(true)
        .skip_taskbar(true) // no taskbar/dock entry for the transient overlay
        .shadow(false)
        .focused(true)
        .visible(true)
        .build()
        .map_err(|e| ServiceError::Other(format!("overlay window: {e}")))?;

    // Belt-and-suspenders: some WMs ignore the builder flag, so re-assert it.
    let _ = win.set_always_on_top(true);
    // Exact size+pos covers the whole monitor more crisply than fullscreen(true),
    // which on macOS would animate the overlay into its own Space.
    #[cfg(target_os = "macos")]
    let _ = win.set_fullscreen(false);
    Ok(())
}

/// Native Wayland degrade: a normal decorated window that crops the static
/// image. No positioning / always-on-top is attempted (tao can't honor it).
fn present_windowed<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("overlay://refresh", ());
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .title("Crop screenshot")
        .inner_size(1100.0, 720.0)
        .resizable(true)
        .decorations(true)
        .center()
        .build()
        .map_err(|e| ServiceError::Other(format!("crop window: {e}")))?;
    Ok(())
}

/// Make the overlay click-through (`ignore == true`) or interactive
/// (`ignore == false`). The frontend flips this so the dimmed region doesn't
/// eat clicks meant for other apps while hovering windows, then turns it back
/// on to draw the rubber-band.
pub fn set_click_through<R: Runtime>(app: &AppHandle<R>, ignore: bool) -> Result<()> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_ignore_cursor_events(ignore)
            .map_err(|e| ServiceError::Other(format!("ignore cursor events: {e}")))?;
    }
    Ok(())
}

/// Close the overlay (on confirm / cancel / Esc) and drop the retained 4K frame
/// so we don't keep tens of MB alive between captures.
pub fn dismiss<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }
    let _ = PENDING_SHOT.lock().unwrap().take();
    capture::clear_last_frame();
}
