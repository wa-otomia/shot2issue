// Single chokepoint for Tauri command invocations (curvault convention:
// components never import @tauri-apps/api directly).
//
// Capture / hotkey / overlay / editor-staging wrappers live in ./capture.ts;
// this module re-exports them plus the updater/window commands the shell uses.
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

/** Open a URL in the system browser (issue links, OAuth pages). */
export const openExternalUrl = (url: string): Promise<void> => shellOpen(url);

export {
  // capture flow
  type MonitorShot,
  type WindowInfo,
  type PendingShots,
  type StagedAttachment,
  getDefaultAccelerator,
  getHotkey,
  setCaptureHotkey,
  triggerCapture,
  captureCurrentMonitor,
  getOverlayShot,
  listWindows,
  captureWindow,
  cropRegion,
  macScreenRecordingAuthorized,
  overlayDismiss,
  openEditorWith,
  getPendingShots,
  onOverlayRefresh,
  onShotsUpdated,
  onNeedsScreenRecording,
  confirmRegion,
  confirmWindow,
  cancelCapture,
} from "./capture";

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
