//! Editor staging — the desktop analogue of the extension's
//! `background.ts::stageAndOpen`.
//!
//! After a crop / window-pick produces a PNG, we stash it (plus metadata) in a
//! process-static "pending shots" envelope and open/focus the `editor` window.
//! The editor view pulls the envelope once on mount via `get_pending_shots`,
//! exactly mirroring the extension contract where the editor reads
//! `chrome.storage.local` pendingShots on load. Re-capturing while the editor
//! is open APPENDS a new attachment (same as the extension).
//!
//! The payload shape matches the extension's `Attachment` / `PendingShots`
//! (camelCase over IPC) so the ported canvas editor can consume it unchanged:
//! `{ attachments: [{ id, dataUrl, ops: [], sourceId, createdAt }] }`.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use super::{Result, ServiceError};

/// A single staged screenshot. `data_url` is a full `data:image/png;base64,…`
/// string, matching the extension's `Attachment.dataUrl`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub data_url: String,
    /// Annotation ops; always empty at staging time (the editor fills it in).
    pub ops: Vec<serde_json::Value>,
    /// Where the shot came from ("capture" for desktop grabs).
    pub source_id: String,
    pub created_at: u64,
}

/// The envelope the editor reads on mount. Mirrors the extension's
/// `PendingShots` (minus the chrome tab/window ids, which have no desktop
/// analogue).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingShots {
    pub attachments: Vec<Attachment>,
}

static PENDING: Mutex<Option<PendingShots>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn make_attachment(png_base64: String) -> Attachment {
    Attachment {
        id: format!("att-{}", now_ms()),
        data_url: format!("data:image/png;base64,{png_base64}"),
        ops: Vec::new(),
        source_id: "capture".into(),
        created_at: now_ms(),
    }
}

/// Stage a freshly cropped PNG and open (or focus + append to) the editor
/// window. `png_base64` is the raw base64 (no data-URL prefix), as returned by
/// `crop_region` / `capture_window`.
pub fn stage_and_open<R: Runtime>(app: &AppHandle<R>, png_base64: String) -> Result<()> {
    let attachment = make_attachment(png_base64);

    let editor_open = app.get_webview_window("editor").is_some();
    {
        let mut guard = PENDING.lock().unwrap();
        match guard.as_mut() {
            // Append to an open editor session (extension parity).
            Some(p) if editor_open => p.attachments.push(attachment),
            // Fresh session.
            _ => {
                *guard = Some(PendingShots {
                    attachments: vec![attachment],
                })
            }
        }
    }

    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.show();
        let _ = win.set_focus();
        // Nudge an already-mounted editor to re-pull the (now longer) envelope.
        use tauri::Emitter;
        let _ = win.emit("editor://shots-updated", ());
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("index.html".into()))
        .title("shot2issue — annotate")
        .inner_size(1180.0, 820.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .center()
        .focused(true)
        .build()
        .map_err(|e| ServiceError::Other(format!("editor window: {e}")))?;
    Ok(())
}

/// The editor view calls this once on mount (and on `editor://shots-updated`)
/// to read the staged shots. Returns `None` if nothing is staged.
pub fn get_pending_shots() -> Option<PendingShots> {
    PENDING.lock().unwrap().clone()
}

/// Clear the staging session (called when the editor window closes, mirroring
/// the extension's `chrome.tabs.onRemoved` cleanup that frees the staged image
/// data).
pub fn clear_pending_shots() {
    *PENDING.lock().unwrap() = None;
}
