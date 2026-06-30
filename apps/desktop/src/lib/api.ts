// Single chokepoint for Tauri command invocations (curvault convention:
// components never import @tauri-apps/api directly).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------- Capture ----------

export interface DisplayInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  isPrimary: boolean;
}
export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A finished capture handed to the annotate stage. `pngDataUrl` is a
 *  data:image/png;base64 string produced in Rust (xcap -> image -> base64). */
export interface CaptureResult {
  pngDataUrl: string;
  width: number;
  height: number;
  scale: number;
  sourceDisplayId: number | null;
}

/** Grab the full screen the cursor is currently on (the hotkey entry point). */
export const captureScreenUnderCursor = (): Promise<CaptureResult> =>
  invoke("capture_screen_under_cursor");
export const listDisplays = (): Promise<DisplayInfo[]> => invoke("list_displays");
export const listWindows = (): Promise<WindowInfo[]> => invoke("list_windows");
export const captureWindow = (windowId: number): Promise<CaptureResult> =>
  invoke("capture_window", { windowId });

/** macOS only: is Screen Recording (TCC) granted? UI uses this to guide the
 *  one-time grant + restart instead of capturing a black frame. */
export const macScreenRecordingAuthorized = (): Promise<boolean> =>
  invoke("mac_screen_recording_authorized");

// ---------- Capture HUD overlay window ----------

/** Open the borderless/transparent/always-on-top HUD over the given display,
 *  seeded with a frozen frame. On native Wayland this is a no-op (returns
 *  false) and the caller falls back to in-window crop. */
export const openOverlay = (displayId: number): Promise<boolean> =>
  invoke("open_overlay", { displayId });
export const closeOverlay = (): Promise<void> => invoke("close_overlay");

// ---------- Global hotkey ----------

export const getHotkey = (): Promise<string> => invoke("get_hotkey");
/** Re-register the global shortcut (e.g. "CommandOrControl+Shift+2"). */
export const setHotkey = (accelerator: string): Promise<void> =>
  invoke("set_hotkey", { accelerator });

// ---------- Updates / windows (copied from curvault) ----------

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  isOutdated: boolean;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string | null;
}
export const checkForUpdates = (): Promise<UpdateInfo> => invoke("check_for_updates");
export const openUpdaterWindow = (): Promise<void> => invoke("open_updater_window");
export const openAboutWindow = (): Promise<void> => invoke("open_about_window");

// ---------- Events ----------

/** Fired by Rust when the global hotkey is pressed (frontend may show a
 *  pre-capture hint); the actual capture is driven from Rust. */
export const onHotkey = (cb: () => void): Promise<UnlistenFn> =>
  listen("hotkey://fired", () => cb());
