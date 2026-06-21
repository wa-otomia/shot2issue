// Storage access for configuration and the pending screenshot.
//
// - Configuration (workspaces, types, language, behavior, last selection) lives in
//   chrome.storage.local and persists across sessions.
// - The screenshot awaiting edit lives in chrome.storage.session (in-memory, cleared
//   when the browser restarts) so large images are not kept on disk.
// This module only reads and writes; it contains no network logic.

import type { Config, Workspace, Account, PendingShot, PendingShots, Attachment, AiAuth, AiPendingAuth } from './types.js';
import { detectLang } from './i18n.js';

/** Default configuration, used on first install and to backfill missing fields. */
const DEFAULT_CONFIG: Config = {
  // Each workspace is an issue target. kind 'github': { id, kind, name, owner, repo };
  // account-based kinds 'youtrack'/'gitlab': { id, kind, name, accountId, project } — the
  // baseUrl/token live on the referenced Account. Missing kind == 'github'.
  workspaces: [],
  // Reusable backend credentials (YouTrack/GitLab instances); shared by workspaces.
  accounts: [],
  // Types shown in the editor's Type dropdown; used as the default title suffix.
  types: ['Change', 'Bug', 'Feature'],
  // UI language: 'en' | 'zh' | 'ja'. English is the default.
  lang: 'en',
  // Default issue title / body templates. Placeholders: {pageTitle}, {pageUrl}, {type}.
  titleTemplate: '{pageTitle} {type}',
  bodyTemplate: 'Page: {pageUrl}',
  // AI title prompt; '' means use the current UI language's default (i18n aiTitlePromptDefault).
  aiTitlePrompt: '',
  // AI complaint prompt; '' means use the current UI language's default (aiComplaintPromptDefault).
  aiComplaintPrompt: '',
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

/** Generate a stable local account id. */
export function makeAccountId(): string {
  return 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Idempotent, lossless migration of legacy inline-credential workspaces to shared Accounts.
 * Pure (no I/O); runs inside getConfig on every read. Heuristic (provider-agnostic, no
 * registry import to avoid a cycle): a workspace with non-empty baseUrl + token and NO
 * accountId is legacy. For each, reuse or create an Account matching (kind, baseUrl, token),
 * set the workspace's accountId, keep its project, and strip the inline baseUrl/token.
 * GitHub workspaces (no baseUrl/token) are never touched.
 */
export function migrateAccounts(config: Config): Config {
  const accounts: Account[] = Array.isArray(config.accounts) ? config.accounts.slice() : [];
  const workspaces = (config.workspaces || []).map((w) => {
    const baseUrl = (w.baseUrl || '').trim();
    const token = (w.token || '').trim();
    if (w.accountId || !baseUrl || !token) return w; // already migrated, or github
    const kind = w.kind || 'youtrack';
    let acct = accounts.find((a) => a.kind === kind && a.baseUrl === baseUrl && a.token === token);
    if (!acct) {
      acct = { id: makeAccountId(), kind, name: hostOf(baseUrl) || baseUrl || kind, baseUrl, token };
      accounts.push(acct);
    }
    const { baseUrl: _b, token: _t, ...rest } = w; // drop the redundant inline creds
    return { ...rest, accountId: acct.id } as Workspace;
  });
  return { ...config, accounts, workspaces };
}

/** Resolve a workspace's Account, or null (github / dangling accountId). */
export function accountFor(config: Config, ws: Workspace): Account | null {
  if (!ws.accountId) return null;
  return config.accounts.find((a) => a.id === ws.accountId) || null;
}

/** Read the full configuration, backfilling any missing fields with defaults + migrating. */
export async function getConfig(): Promise<Config> {
  const raw = await chrome.storage.local.get(CONFIG_KEY);
  const stored = (raw[CONFIG_KEY] ?? {}) as Partial<Config>;
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...stored,
    workspaces: Array.isArray(stored.workspaces) ? (stored.workspaces as Workspace[]) : [],
    accounts: Array.isArray(stored.accounts) ? (stored.accounts as Account[]) : [],
    types: Array.isArray(stored.types) && stored.types.length ? stored.types : DEFAULT_CONFIG.types.slice(),
  };
  // First install (nothing stored yet, no explicit language): default to the system language.
  if (raw[CONFIG_KEY] == null && stored.lang == null) merged.lang = detectLang();
  return migrateAccounts(merged);
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

// The active Settings tab is UI-only and lives under its own key so it never appears in
// configuration exports.
const OPTIONS_TAB_KEY = 'optionsTab';
export async function getOptionsTab(): Promise<string> {
  const raw = await chrome.storage.local.get(OPTIONS_TAB_KEY);
  return (raw[OPTIONS_TAB_KEY] as string) || 'workspaces';
}
export async function setOptionsTab(tab: string): Promise<void> {
  await chrome.storage.local.set({ [OPTIONS_TAB_KEY]: tab });
}

/** Remember the current selection (called when the editor changes workspace/type). */
export async function rememberSelection({ workspaceId, type }: { workspaceId?: string; type?: string }): Promise<Config> {
  const patch: Partial<Config> = {};
  if (workspaceId !== undefined) patch.lastWorkspaceId = workspaceId;
  if (type !== undefined) patch.lastType = type;
  return patchConfig(patch);
}

// ---- Pending screenshots (session storage) ---------------------------------
//
// Written by the service worker when the icon/shortcut captures, read by the editor.
// Multiple attachments are staged together and edited as one issue. A legacy single-shot
// envelope (pendingShot) is migrated on read.
const PENDING_KEY = 'pendingShot'; // legacy single shot
const PENDING_SHOTS_KEY = 'pendingShots'; // multi-attachment envelope

/** Generate a stable local attachment id. */
export function makeAttachmentId(): string {
  return 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function shotToAttachment(shot: PendingShot): Attachment {
  return {
    id: makeAttachmentId(),
    dataUrl: shot.dataUrl || '',
    pageUrl: shot.pageUrl,
    pageTitle: shot.pageTitle,
    sourceTabId: shot.sourceTabId,
    sourceWindowId: shot.sourceWindowId,
    ops: [],
    createdAt: Date.now(),
  };
}

/** Read the staged screenshots, migrating a legacy single shot if that's all there is. */
export async function getPendingShots(): Promise<PendingShots | null> {
  const raw = await chrome.storage.session.get([PENDING_SHOTS_KEY, PENDING_KEY]);
  const envelope = raw[PENDING_SHOTS_KEY] as PendingShots | undefined;
  if (envelope) return envelope;
  const legacy = raw[PENDING_KEY] as PendingShot | undefined;
  if (!legacy) return null;
  if (legacy.error) return { attachments: [], type: legacy.type, workspaceId: legacy.workspaceId, error: legacy.error };
  return {
    attachments: legacy.dataUrl ? [shotToAttachment(legacy)] : [],
    type: legacy.type,
    workspaceId: legacy.workspaceId,
    sourceTabId: legacy.sourceTabId,
    sourceWindowId: legacy.sourceWindowId,
  };
}

/** Stage the full set of screenshots for editing. */
export async function setPendingShots(p: PendingShots): Promise<void> {
  await chrome.storage.session.set({ [PENDING_SHOTS_KEY]: p });
}

/** Update a subset of the staged set (read-modify-write). */
export async function patchPendingShots(patch: Partial<PendingShots>): Promise<PendingShots> {
  const current = (await getPendingShots()) ?? { attachments: [] };
  const next = { ...current, ...patch };
  await setPendingShots(next);
  return next;
}

/** Append one attachment to the staged set (used when re-capturing into an open editor). */
export async function appendPendingShot(att: Attachment): Promise<PendingShots> {
  const current = (await getPendingShots()) ?? { attachments: [] };
  const next: PendingShots = { ...current, error: undefined, attachments: [...current.attachments, att] };
  await setPendingShots(next);
  return next;
}

/** Clear the staged screenshots (both the new and legacy keys). */
export async function clearPendingShots(): Promise<void> {
  await chrome.storage.session.remove([PENDING_SHOTS_KEY, PENDING_KEY]);
}

// ---- AI assistant credentials (local storage) ------------------------------
//
// Stored under their own key, kept out of Config so configuration export/import never
// carries the access/refresh tokens. The pending PKCE state lives in session storage and
// is discarded when the flow completes (or the browser restarts).
const AI_AUTH_KEY = 'aiAuth';
const AI_PENDING_KEY = 'aiPendingAuth';

/** Read the stored AI credentials, or null if the assistant is not connected. */
export async function getAiAuth(): Promise<AiAuth | null> {
  const raw = await chrome.storage.local.get(AI_AUTH_KEY);
  return (raw[AI_AUTH_KEY] as AiAuth | undefined) ?? null;
}

/** Persist the AI credentials. */
export async function setAiAuth(auth: AiAuth): Promise<void> {
  await chrome.storage.local.set({ [AI_AUTH_KEY]: auth });
}

/** Update a subset of the stored AI credentials (no-op if not connected). */
export async function patchAiAuth(patch: Partial<AiAuth>): Promise<AiAuth | null> {
  const current = await getAiAuth();
  if (!current) return null;
  const next = { ...current, ...patch };
  await setAiAuth(next);
  return next;
}

/** Disconnect the AI assistant. */
export async function clearAiAuth(): Promise<void> {
  await chrome.storage.local.remove(AI_AUTH_KEY);
}

/** Stash the PKCE verifier/state while the user completes the OAuth flow. */
export async function setPendingAuth(pending: AiPendingAuth): Promise<void> {
  await chrome.storage.session.set({ [AI_PENDING_KEY]: pending });
}

/** Read the in-flight OAuth PKCE state. */
export async function getPendingAuth(): Promise<AiPendingAuth | null> {
  const raw = await chrome.storage.session.get(AI_PENDING_KEY);
  return (raw[AI_PENDING_KEY] as AiPendingAuth | undefined) ?? null;
}

/** Discard the in-flight OAuth PKCE state. */
export async function clearPendingAuth(): Promise<void> {
  await chrome.storage.session.remove(AI_PENDING_KEY);
}
