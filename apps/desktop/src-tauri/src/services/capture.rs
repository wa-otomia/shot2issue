//! Screen capture service. All pixel work lives here; the webview only ever
//! receives base64 PNG strings and integer rects, never a handle to the live
//! desktop. That keeps us inside WKWebView's CORS/sandbox limits and means the
//! crop math is identical on every platform.
//!
//! Geometry contract: every coordinate that crosses IPC (`MonitorShot`,
//! `WindowInfo`, the `Display` list) is reported in LOGICAL px in the global
//! virtual-desktop space, so the overlay WebviewWindow — which Tauri sizes and
//! positions in logical units — lines up 1:1 with the frozen frame. The crop
//! step converts logical px -> device px via the monitor's scale factor before
//! slicing the RGBA buffer.
//!
//! xcap 0.9.6 API used here (verified against the v0.9.6 source, not docs.rs
//! which fails to build that tag):
//!   Monitor::all() -> XCapResult<Vec<Monitor>>
//!   Monitor::from_point(i32, i32) -> XCapResult<Monitor>
//!   Monitor::{id,x,y,width,height}() -> XCapResult<{u32|i32}>
//!   Monitor::scale_factor() -> XCapResult<f32>
//!   Monitor::is_primary() -> XCapResult<bool>
//!   Monitor::name() -> XCapResult<String>
//!   Monitor::capture_image() -> XCapResult<RgbaImage>   (image::ImageBuffer<Rgba<u8>, Vec<u8>>)
//!   Window::all() -> XCapResult<Vec<Window>>
//!   Window::{id,x,y,width,height}() -> XCapResult<{u32|i32}>
//!   Window::{title,app_name}() -> XCapResult<String>
//!   Window::is_minimized() -> XCapResult<bool>
//!   Window::current_monitor() -> XCapResult<Monitor>
//!   Window::capture_image() -> XCapResult<RgbaImage>

use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use xcap::{Monitor, Window};

use super::{Result, ServiceError};

/// A captured monitor frame, kept in memory between the capture and the crop so
/// the overlay can request it as a data URL and the crop can run server-side.
#[derive(Clone)]
struct Frame {
    /// RGBA8 pixels, `width * height * 4` bytes, row-major top-down.
    rgba: Vec<u8>,
    /// device-px dimensions of the buffer.
    width: u32,
    height: u32,
    /// device pixels per logical px for this monitor (Retina / Windows scaling).
    scale: f64,
    /// Monotonic id of this frame. A reused overlay carries the token of the
    /// frame it was handed; the crop path checks it against the CURRENT
    /// `LAST_FRAME` so a rapid re-capture can't make a stale overlay crop the
    /// wrong (newer) frozen frame.
    token: u64,
}

/// The most-recent frozen frame. Held only between a capture and its crop; the
/// overlay clears it on dismiss so we don't retain a 30-60 MB 4K buffer.
static LAST_FRAME: Mutex<Option<Frame>> = Mutex::new(None);

/// Monotonic frame-token source. Bumped on every successful `capture_at` and
/// stamped into both `LAST_FRAME` and the `MonitorShot` handed to the overlay.
static FRAME_TOKEN: Mutex<u64> = Mutex::new(0);

/// Allocate the next frame token (starts at 1; 0 is never a valid frame token,
/// so a defaulted/absent token can't accidentally match a live frame).
fn next_frame_token() -> u64 {
    let mut t = FRAME_TOKEN.lock().unwrap();
    *t += 1;
    *t
}

/// A connected display (used by the foreground display picker / shell). Mirrors
/// `DisplayInfo` in src/lib/api.ts. All geometry in LOGICAL px.
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

/// Metadata the overlay needs to size + place its window exactly over the
/// captured monitor. The PNG rides along as base64. Geometry is LOGICAL px in
/// the virtual desktop. Mirrors `MonitorShot` in src/lib/capture.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorShot {
    /// base64-encoded PNG of the full monitor.
    pub png_base64: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub monitor_name: String,
    /// Monotonic id of the frozen frame this shot refers to. The overlay echoes
    /// it back on `crop_region` so the crop can reject a stale request after a
    /// rapid re-capture replaced `LAST_FRAME`.
    pub token: u64,
}

/// An enumerated top-level window for the window-pick UX. Bounds in LOGICAL px,
/// virtual-desktop space (matches `MonitorShot.x/y`). Mirrors `WindowInfo` in
/// src/lib/capture.ts.
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
    pub is_minimized: bool,
}

fn map_xcap(e: xcap::XCapError) -> ServiceError {
    ServiceError::Other(format!("capture failed: {e}"))
}

/// True when running under a native Wayland session (where xcap cannot grab and
/// Tauri cannot freely position the always-on-top overlay). Runtime probe used
/// by the shell + the hotkey path to pick the in-window degrade flow. We treat
/// XWayland (GDK_BACKEND=x11) as X11 since xcap/tao behave like X11 there.
pub fn is_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        // An explicit X11 backend override means we're effectively on XWayland.
        if std::env::var("GDK_BACKEND")
            .map(|b| b.split(',').any(|t| t.eq_ignore_ascii_case("x11")))
            .unwrap_or(false)
        {
            return false;
        }
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return true;
        }
        std::env::var("XDG_SESSION_TYPE")
            .map(|s| s.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<String> {
    use image::{ImageBuffer, Rgba};
    let buf: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| ServiceError::Other("capture buffer size mismatch".into()))?;
    let mut out: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(buf)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| ServiceError::Other(format!("png encode: {e}")))?;
    Ok(STANDARD.encode(out))
}

/// Resolve the primary monitor as a fallback when a point lookup fails (e.g.
/// the cursor sits between monitors during a hotplug).
fn primary_monitor() -> Result<Monitor> {
    let monitors = Monitor::all().map_err(map_xcap)?;
    // Prefer the flagged primary; else the first enumerated monitor.
    let mut first: Option<Monitor> = None;
    for m in monitors {
        if m.is_primary().unwrap_or(false) {
            return Ok(m);
        }
        if first.is_none() {
            first = Some(m);
        }
    }
    first.ok_or_else(|| ServiceError::Other("no monitors found".into()))
}

/// Capture the monitor that contains `(cursor_x, cursor_y)` (global device px,
/// supplied by the Rust hotkey handler from `AppHandle::cursor_position`).
/// Stashes the frame and returns it as a `MonitorShot` in LOGICAL geometry.
pub fn capture_at(cursor_x: i32, cursor_y: i32) -> Result<MonitorShot> {
    let monitor = match Monitor::from_point(cursor_x, cursor_y) {
        Ok(m) => m,
        Err(_) => primary_monitor()?,
    };
    let scale = monitor.scale_factor().map_err(map_xcap)? as f64;
    let x = monitor.x().map_err(map_xcap)?;
    let y = monitor.y().map_err(map_xcap)?;
    let monitor_name = monitor.name().unwrap_or_default();

    let img = monitor.capture_image().map_err(map_xcap)?; // RgbaImage
    let (w, h) = (img.width(), img.height());
    let rgba = img.into_raw();
    let png = encode_png(&rgba, w, h)?;

    // Stamp a fresh token so the overlay handed this shot can prove, at crop
    // time, that `LAST_FRAME` hasn't been replaced by a newer capture.
    let token = next_frame_token();
    *LAST_FRAME.lock().unwrap() = Some(Frame { rgba, width: w, height: h, scale, token });

    Ok(MonitorShot {
        png_base64: png,
        // LOGICAL geometry: divide the device-px buffer dims by the scale so the
        // overlay window (logical units) covers exactly the captured monitor.
        x,
        y,
        width: ((w as f64) / scale).round() as u32,
        height: ((h as f64) / scale).round() as u32,
        scale,
        monitor_name,
        token,
    })
}

/// Foreground entry point: capture the monitor under the cursor right now. The
/// cursor point is read by the caller (command layer) and threaded in. Retained
/// as a named helper to match the Phase 3 surface (`screen_under_cursor`).
pub fn screen_under_cursor(cursor_x: i32, cursor_y: i32) -> Result<MonitorShot> {
    capture_at(cursor_x, cursor_y)
}

/// Enumerate connected displays in LOGICAL px (used by a foreground display
/// picker; the hotkey path uses `capture_at` directly).
///
/// `Monitor::width()`/`height()` are NOT consistently reported in the same unit
/// across platforms: on macOS xcap sources them from `CGDisplayBounds`, which is
/// ALREADY in logical points (same quirk as `kCGWindowBounds`, documented above
/// `list_windows_macos`), so dividing by `scale_factor()` here would halve a
/// Retina display's reported size (1920x1080 -> 960x540). On Windows/Linux xcap
/// reports physical/device pixels for monitors (consistent with `capture_at`,
/// which derives `MonitorShot.width/height` from the captured device-px image
/// buffer divided by scale), so the division must stay for those platforms.
pub fn list_displays() -> Result<Vec<Display>> {
    let monitors = Monitor::all().map_err(map_xcap)?;
    let mut out = Vec::with_capacity(monitors.len());
    for m in monitors {
        let scale = m.scale_factor().map_err(map_xcap)? as f64;
        let raw_w = m.width().map_err(map_xcap)? as f64;
        let raw_h = m.height().map_err(map_xcap)? as f64;
        #[cfg(target_os = "macos")]
        let (width, height) = (raw_w.round() as u32, raw_h.round() as u32);
        #[cfg(not(target_os = "macos"))]
        let (width, height) = ((raw_w / scale).round() as u32, (raw_h / scale).round() as u32);
        out.push(Display {
            id: m.id().map_err(map_xcap)?,
            name: m.name().unwrap_or_default(),
            x: m.x().map_err(map_xcap)?,
            y: m.y().map_err(map_xcap)?,
            width,
            height,
            scale: scale as f32,
            is_primary: m.is_primary().unwrap_or(false),
        });
    }
    Ok(out)
}

/// Look up an enumerated display by id (foreground display-picker path; the
/// hotkey flow captures the monitor under the cursor directly). Part of the
/// public capture surface even though no command wires it yet.
#[allow(dead_code)]
pub fn find_display(display_id: u32) -> Option<Display> {
    list_displays().ok()?.into_iter().find(|d| d.id == display_id)
}

/// List top-level windows for the window-pick UX. Skips minimized / untitled
/// helper windows. Bounds reported in LOGICAL px in the virtual-desktop space
/// so the frontend can highlight them over the frozen overlay.
pub fn list_windows() -> Result<Vec<WindowInfo>> {
    #[cfg(target_os = "macos")]
    {
        list_windows_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        list_windows_xcap()
    }
}

// Non-macOS: the original xcap enumeration, unchanged. macOS diverges below to a
// CGWindowList path that fixes both the Retina-halved bounds (#1) and the
// z-order / layer filtering (#2).
#[cfg(not(target_os = "macos"))]
fn list_windows_xcap() -> Result<Vec<WindowInfo>> {
    let wins = Window::all().map_err(map_xcap)?;
    let mut out = Vec::with_capacity(wins.len());
    for w in wins {
        let minimized = w.is_minimized().unwrap_or(false);
        if minimized {
            continue;
        }
        let title = w.title().unwrap_or_default();
        if title.trim().is_empty() {
            continue; // skip chromeless helper windows
        }
        let scale = w
            .current_monitor()
            .ok()
            .and_then(|m| m.scale_factor().ok())
            .unwrap_or(1.0) as f64;
        out.push(WindowInfo {
            id: w.id().unwrap_or(0),
            title,
            app_name: w.app_name().unwrap_or_default(),
            x: ((w.x().map_err(map_xcap)? as f64) / scale).round() as i32,
            y: ((w.y().map_err(map_xcap)? as f64) / scale).round() as i32,
            width: ((w.width().map_err(map_xcap)? as f64) / scale).round() as u32,
            height: ((w.height().map_err(map_xcap)? as f64) / scale).round() as u32,
            is_minimized: minimized,
        });
    }
    Ok(out)
}

// macOS-native window enumeration: authoritative bounds (logical points) AND
// front-to-back z-order in one CGWindowListCopyWindowInfo call. xcap on macOS
// returns kCGWindowBounds ALREADY in logical points (dividing by scale halved
// them on Retina — bug #1) and doesn't filter by kCGWindowLayer (menu bar /
// Dock / notifications sit above real windows and were picked first — bug #2).
// CGWindowNumber == xcap Window::id(), so capture_window(id) is unchanged.
#[cfg(target_os = "macos")]
fn list_windows_macos() -> Result<Vec<WindowInfo>> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, ItemRef, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::display::{
        kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        CGWindowListCopyWindowInfo,
    };
    use std::os::raw::c_void;

    let array_ref = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    };
    if array_ref.is_null() {
        return Err(ServiceError::Other(
            "CGWindowListCopyWindowInfo returned null".into(),
        ));
    }
    // Create Rule: we own this reference; CFArray drops it.
    let array: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(array_ref) };

    let k_layer = CFString::from_static_string("kCGWindowLayer");
    let k_number = CFString::from_static_string("kCGWindowNumber");
    let k_owner = CFString::from_static_string("kCGWindowOwnerName");
    let k_name = CFString::from_static_string("kCGWindowName");
    let k_bounds = CFString::from_static_string("kCGWindowBounds");
    let k_alpha = CFString::from_static_string("kCGWindowAlpha");
    let k_x = CFString::from_static_string("X");
    let k_y = CFString::from_static_string("Y");
    let k_w = CFString::from_static_string("Width");
    let k_h = CFString::from_static_string("Height");

    let mut out = Vec::with_capacity(array.len() as usize);

    // Front-to-back (topmost first). Preserve the order so the frontend's
    // "first hit wins" grabs the TOPMOST window under the cursor.
    for item in array.iter() {
        let dict_ref = *item as core_foundation::dictionary::CFDictionaryRef;
        if dict_ref.is_null() {
            continue;
        }
        let dict: CFDictionary<*const c_void, *const c_void> =
            unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };

        let get = |key: &CFString| -> Option<ItemRef<'_, *const c_void>> {
            dict.find(key.as_CFTypeRef() as *const c_void)
        };
        let get_number_f64 = |key: &CFString| -> Option<f64> {
            let v = get(key)?;
            let cf: CFType = unsafe { CFType::wrap_under_get_rule(*v as _) };
            cf.downcast::<CFNumber>().and_then(|n| n.to_f64())
        };
        let get_string = |key: &CFString| -> Option<String> {
            let v = get(key)?;
            let cf: CFType = unsafe { CFType::wrap_under_get_rule(*v as _) };
            cf.downcast::<CFString>().map(|s| s.to_string())
        };

        // Only real application windows live on layer 0; the Dock, menu bar
        // extras, notification overlays, wallpaper agents etc. sit ABOVE that
        // and would otherwise be picked first (breaking z-order picking).
        let layer = get_number_f64(&k_layer).unwrap_or(1.0);
        if layer != 0.0 {
            continue;
        }
        if get_number_f64(&k_alpha).unwrap_or(1.0) <= 0.0 {
            continue; // fully transparent — can't be meaningfully clicked
        }

        let id = match get_number_f64(&k_number) {
            Some(n) => n as u32,
            None => continue,
        };
        let title = get_string(&k_name).unwrap_or_default();
        if title.trim().is_empty() {
            continue; // chromeless helper windows
        }
        let app_name = get_string(&k_owner).unwrap_or_default();

        // kCGWindowBounds is a sub-dict of numbers (X/Y/Width/Height) in GLOBAL
        // LOGICAL POINTS — the same space as MonitorShot.x/y. No scale.
        let bounds_ref = match get(&k_bounds) {
            Some(v) => *v as core_foundation::dictionary::CFDictionaryRef,
            None => continue,
        };
        if bounds_ref.is_null() {
            continue;
        }
        let bounds: CFDictionary<*const c_void, *const c_void> =
            unsafe { CFDictionary::wrap_under_get_rule(bounds_ref) };
        let bnum = |key: &CFString| -> f64 {
            bounds
                .find(key.as_CFTypeRef() as *const c_void)
                .and_then(|v| {
                    let cf: CFType = unsafe { CFType::wrap_under_get_rule(*v as _) };
                    cf.downcast::<CFNumber>().and_then(|n| n.to_f64())
                })
                .unwrap_or(0.0)
        };
        let wx = bnum(&k_x);
        let wy = bnum(&k_y);
        let ww = bnum(&k_w);
        let wh = bnum(&k_h);
        if ww <= 1.0 || wh <= 1.0 {
            continue; // 1px helper / off-screen sliver
        }

        out.push(WindowInfo {
            id,
            title,
            app_name,
            x: wx.round() as i32,
            y: wy.round() as i32,
            width: ww.round() as u32,
            height: wh.round() as u32,
            is_minimized: false, // OnScreenOnly ⇒ everything returned is on-screen
        });
    }
    Ok(out)
}

/// Capture a single window directly (window-pick confirm path). xcap can grab a
/// window even when partly occluded on Win/macOS; on X11 it falls back to the
/// on-screen region. Returns a tight base64 PNG.
pub fn capture_window(id: u32) -> Result<String> {
    let win = Window::all()
        .map_err(map_xcap)?
        .into_iter()
        .find(|w| w.id().map(|i| i == id).unwrap_or(false))
        .ok_or_else(|| ServiceError::Other("window not found".into()))?;
    let img = win.capture_image().map_err(map_xcap)?;
    let (w, h) = (img.width(), img.height());
    encode_png(&img.into_raw(), w, h)
}

/// Crop the most-recent frozen frame to a rect given in LOGICAL px relative to
/// the captured monitor's top-left (i.e. overlay-window client coords). Scales
/// to device px, edge-clamps, and returns a tight base64 PNG.
///
/// `token` is the frame id the overlay was handed (`MonitorShot.token`). If a
/// rapid re-capture has since replaced `LAST_FRAME`, the tokens won't match and
/// we error instead of cropping the WRONG (newer) frozen frame against the old
/// overlay's coordinates.
pub fn crop_last(token: u64, x: f64, y: f64, w: f64, h: f64) -> Result<String> {
    let guard = LAST_FRAME.lock().unwrap();
    let frame = guard
        .as_ref()
        .ok_or_else(|| ServiceError::Other("no frozen frame".into()))?;
    if frame.token != token {
        return Err(ServiceError::Other(format!(
            "stale crop: overlay frame {token} no longer current ({})",
            frame.token
        )));
    }
    crop_frame(frame, x, y, w, h)
}

/// Back-compat crop with no frame token: crops whatever `LAST_FRAME` currently
/// holds. Used only for an older renderer that doesn't yet send the token; the
/// token path (`crop_last`) is the race-safe one. Remove once the overlay always
/// threads `MonitorShot.token` through `crop_region`.
pub fn crop_last_untokened(x: f64, y: f64, w: f64, h: f64) -> Result<String> {
    let guard = LAST_FRAME.lock().unwrap();
    let frame = guard
        .as_ref()
        .ok_or_else(|| ServiceError::Other("no frozen frame".into()))?;
    crop_frame(frame, x, y, w, h)
}

/// Scale a logical-px rect to device px against `frame`, then slice + encode.
/// Rejects non-finite or non-positive geometry BEFORE any float->int cast, so a
/// bogus/adversarial webview payload (Infinity/NaN/huge width) can never reach
/// the `as u32` casts below, which otherwise saturate to `u32::MAX` and blow up
/// the clamping arithmetic in `crop_rgba`.
fn crop_frame(frame: &Frame, x: f64, y: f64, w: f64, h: f64) -> Result<String> {
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return Err(ServiceError::Other("crop rect is not finite".into()));
    }
    if w <= 0.0 || h <= 0.0 {
        return Err(ServiceError::Other("crop rect has non-positive size".into()));
    }
    let s = frame.scale;
    let dx = (x * s).round() as i64;
    let dy = (y * s).round() as i64;
    let dw = (w * s).round() as u32;
    let dh = (h * s).round() as u32;
    crop_rgba(&frame.rgba, frame.width, frame.height, dx, dy, dw, dh)
}

/// Slice an RGBA buffer to a device-px rect, clamped to the frame bounds so an
/// over-pull at a screen edge can't panic. All clamping uses saturating/checked
/// arithmetic so a huge or fully out-of-bounds rect errors instead of wrapping.
fn crop_rgba(
    rgba: &[u8],
    fw: u32,
    fh: u32,
    x: i64,
    y: i64,
    mut w: u32,
    mut h: u32,
) -> Result<String> {
    if fw == 0 || fh == 0 || w == 0 || h == 0 {
        return Err(ServiceError::Other("empty crop".into()));
    }
    if x >= fw as i64 || y >= fh as i64 {
        return Err(ServiceError::Other("empty crop".into()));
    }
    let x = x.clamp(0, fw as i64) as u32;
    let y = y.clamp(0, fh as i64) as u32;
    w = w.min(fw - x);
    h = h.min(fh - y);
    if w == 0 || h == 0 {
        return Err(ServiceError::Other("empty crop".into()));
    }
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        let src = (((y + row) * fw + x) * 4) as usize;
        out.extend_from_slice(&rgba[src..src + (w * 4) as usize]);
    }
    encode_png(&out, w, h)
}

/// Drop the retained frame (called on overlay dismiss) so we don't keep a
/// multi-MB 4K buffer alive after the crop is done.
pub fn clear_last_frame() {
    *LAST_FRAME.lock().unwrap() = None;
}

/// Heuristic: a freshly captured frame that is entirely black almost always
/// means macOS denied Screen Recording (TCC). The hotkey path uses this to
/// route the user to the grant + restart flow instead of opening an empty
/// overlay. Cheap sample of a sparse grid of pixels rather than the whole buf.
#[cfg(target_os = "macos")]
pub fn last_frame_is_all_black() -> bool {
    let guard = LAST_FRAME.lock().unwrap();
    let Some(frame) = guard.as_ref() else {
        return false;
    };
    let px = frame.rgba.len() / 4;
    if px == 0 {
        return false;
    }
    // Sample up to ~4096 pixels evenly across the frame.
    let step = (px / 4096).max(1);
    let mut i = 0;
    while i < px {
        let o = i * 4;
        // Any non-black RGB component means real content was captured.
        if frame.rgba[o] != 0 || frame.rgba[o + 1] != 0 || frame.rgba[o + 2] != 0 {
            return false;
        }
        i += step;
    }
    true
}

/// macOS: is Screen Recording (TCC) authorized? Probes core-graphics'
/// `ScreenCaptureAccess::preflight` (the safe wrapper around the private
/// `CGPreflightScreenCaptureAccess`), which does NOT prompt. Other platforms
/// always return true.
#[cfg(target_os = "macos")]
pub fn mac_screen_recording_authorized() -> bool {
    core_graphics::access::ScreenCaptureAccess::default().preflight()
}

/// macOS: request Screen Recording access. `preflight` only reads the current
/// state; `request` opens the System Settings pane the first time. Kept so the
/// UI can trigger the grant prompt before guiding a restart.
#[cfg(target_os = "macos")]
pub fn mac_request_screen_recording() -> bool {
    core_graphics::access::ScreenCaptureAccess::default().request()
}

#[cfg(not(target_os = "macos"))]
pub fn mac_screen_recording_authorized() -> bool {
    true
}
