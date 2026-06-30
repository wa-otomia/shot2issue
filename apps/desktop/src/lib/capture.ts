// Capture flow: invoke() wrappers + the hotkey -> overlay -> crop -> editor
// pipeline. Single chokepoint, mirroring curvault's src/lib/api.ts convention
// (components never import @tauri-apps/api directly).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Metadata + base64 PNG for the frozen monitor the overlay paints. Geometry
 *  is LOGICAL px in the virtual desktop, so overlay-window units line up 1:1. */
export interface MonitorShot {
  pngBase64: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  monitorName: string;
}

/** A top-level window for the window-pick UX. Bounds in LOGICAL px,
 *  virtual-desktop space (matches MonitorShot.x/y). */
export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isMinimized: boolean;
}

// ---- hotkey ----

export const getDefaultAccelerator = (): Promise<string> =>
  invoke("get_default_accelerator");
export const getHotkey = (): Promise<string> => invoke("get_hotkey");
/** Rejected promise on Wayland / parse failure / chord-in-use; caller shows it. */
export const setCaptureHotkey = (accelerator: string): Promise<void> =>
  invoke("set_capture_hotkey", { accelerator });
/** Fire the same path as the global hotkey (tray / "Capture now" button). */
export const triggerCapture = (): Promise<void> => invoke("trigger_capture");

// ---- capture ----

/** Capture the monitor under the cursor right now (foreground button path). */
export const captureCurrentMonitor = (): Promise<MonitorShot> =>
  invoke("capture_current_monitor");
/** Pull the frozen shot the overlay should paint (called on overlay mount). */
export const getOverlayShot = (): Promise<MonitorShot | null> =>
  invoke("get_overlay_shot");
export const listWindows = (): Promise<WindowInfo[]> => invoke("list_windows");
export const captureWindow = (id: number): Promise<string> =>
  invoke("capture_window", { id });
/** rect is in LOGICAL px relative to the overlay client area. Returns base64. */
export const cropRegion = (
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<string> => invoke("crop_region", { x, y, width, height });
/** macOS only: is Screen Recording (TCC) granted? */
export const macScreenRecordingAuthorized = (): Promise<boolean> =>
  invoke("mac_screen_recording_authorized");

// ---- overlay ----

export const overlaySetClickThrough = (ignore: boolean): Promise<void> =>
  invoke("overlay_set_click_through", { ignore });
export const overlayDismiss = (): Promise<void> => invoke("overlay_dismiss");

// ---- editor staging ----

export const openEditorWith = (pngBase64: string): Promise<void> =>
  invoke("open_editor_with", { pngBase64 });

/** A single staged screenshot (mirrors the extension's Attachment shape). */
export interface StagedAttachment {
  id: string;
  dataUrl: string;
  ops: unknown[];
  sourceId: string;
  createdAt: number;
}
export interface PendingShots {
  attachments: StagedAttachment[];
}

/** The editor window reads the staged shots on mount (and on the update event,
 *  when a re-capture appends to an open session). */
export const getPendingShots = (): Promise<PendingShots | null> =>
  invoke("get_pending_shots");

/** Fired when a re-capture appends a shot to the already-open editor. */
export const onShotsUpdated = (cb: () => void): Promise<UnlistenFn> =>
  listen("editor://shots-updated", () => cb());

// ---- events the overlay window listens for ----

/** Re-emitted when the same overlay window is reused for a fresh capture. */
export const onOverlayRefresh = (cb: () => void): Promise<UnlistenFn> =>
  listen("overlay://refresh", () => cb());

/** macOS: emitted when a capture came back black (TCC denied) so the UI can
 *  guide the Screen-Recording grant + restart. */
export const onNeedsScreenRecording = (cb: () => void): Promise<UnlistenFn> =>
  listen("capture://needs-screen-recording", () => cb());

// ---- orchestration (runs inside the overlay window) ----

/**
 * Confirm a region selection: ask Rust to crop the frozen frame, hand the PNG
 * to the editor, and close the overlay. `rect` is in CSS px of the overlay
 * client area, which equals logical monitor px (the overlay is sized 1:1).
 */
export async function confirmRegion(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<void> {
  const png = await cropRegion(rect.x, rect.y, rect.w, rect.h);
  await openEditorWith(png);
  await overlayDismiss();
}

/** Confirm a window pick: capture that window tight, hand to editor, close. */
export async function confirmWindow(id: number): Promise<void> {
  const png = await captureWindow(id);
  await openEditorWith(png);
  await overlayDismiss();
}

/** Esc / cancel: just close the overlay (Rust drops the frozen frame). */
export async function cancelCapture(): Promise<void> {
  await overlayDismiss();
}
