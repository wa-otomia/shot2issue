// Storage access for configuration and the pending screenshot.
//
// - Configuration (workspaces, types, language, behavior, last selection) lives in
//   chrome.storage.local and persists across sessions.
// - The screenshot awaiting edit lives in chrome.storage.session (in-memory, cleared
//   when the browser restarts) so large images are not kept on disk.
// This module only reads and writes; it contains no network logic.

import type { Config, Workspace, PendingShot } from './types.js';

/** Default configuration, used on first install and to backfill missing fields. */
const DEFAULT_CONFIG: Config = {
  // Each workspace is an issue target. kind 'github': { id, kind, name, owner, repo };
  // kind 'youtrack': { id, kind, name, baseUrl, project, token }. Missing kind == 'github'.
  workspaces: [],
  // Types shown in the editor's Type dropdown; used as the default title suffix.
  types: ['Change', 'Bug', 'Feature'],
  // UI language: 'en' | 'zh' | 'ja'. English is the default.
  lang: 'en',
  // Close the editor and switch back to the captured tab after a successful submit.
  closeAfterSubmit: true,
  // Allow a keyboard shortcut (configured at chrome://extensions/shortcuts) to capture. Off by default.
  shortcutEnabled: false,
  // Remembered selection: reused as the default the next time the editor opens.
  lastWorkspaceId: '',
  lastType: '',
};

const CONFIG_KEY = 'config';

/** Generate a stable local id without external dependencies. */
export function makeId(): string {
  return 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Read the full configuration, backfilling any missing fields with defaults. */
export async function getConfig(): Promise<Config> {
  const raw = await chrome.storage.local.get(CONFIG_KEY);
  const stored = (raw[CONFIG_KEY] ?? {}) as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    workspaces: Array.isArray(stored.workspaces) ? (stored.workspaces as Workspace[]) : [],
    types: Array.isArray(stored.types) && stored.types.length ? stored.types : DEFAULT_CONFIG.types.slice(),
  };
}

/** Persist the full configuration. */
export async function setConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

/** Update a subset of fields (read-modify-write). */
export async function patchConfig(patch: Partial<Config>): Promise<Config> {
  const config = await getConfig();
  const next = { ...config, ...patch };
  await setConfig(next);
  return next;
}

/** Remember the current selection (called when the editor changes workspace/type). */
export async function rememberSelection({ workspaceId, type }: { workspaceId?: string; type?: string }): Promise<Config> {
  const patch: Partial<Config> = {};
  if (workspaceId !== undefined) patch.lastWorkspaceId = workspaceId;
  if (type !== undefined) patch.lastType = type;
  return patchConfig(patch);
}

// ---- Pending screenshot (session storage) ----------------------------------
//
// Written by the service worker when the icon is clicked, read by the editor.
// Single fixed key; one screenshot is processed at a time.
const PENDING_KEY = 'pendingShot';

/**
 * Stage a screenshot and its context for editing.
 * @param shot dataUrl + page metadata, or { error } when capture failed.
 */
export async function setPendingShot(shot: PendingShot): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: shot });
}

/** Read the staged screenshot. */
export async function getPendingShot(): Promise<PendingShot | null> {
  const raw = await chrome.storage.session.get(PENDING_KEY);
  return (raw[PENDING_KEY] as PendingShot | undefined) ?? null;
}

/** Clear the staged screenshot to avoid keeping a large image in memory. */
export async function clearPendingShot(): Promise<void> {
  await chrome.storage.session.remove(PENDING_KEY);
}
