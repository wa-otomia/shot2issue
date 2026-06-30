// Storage access for configuration and the pending screenshots, over a StoragePort.
//
// Same API surface as the extension's lib/storage.ts: the chrome.storage.local/session calls
// are replaced by an injected StoragePort (extension → chrome.storage; desktop → tauri-plugin-
// store). All the pure logic (DEFAULT_CONFIG, DEFAULT_EDITOR_PREFS, migrateAccounts, accountFor,
// shotToAttachment, id generators) is copied verbatim from lib/storage.ts. This module only
// reads and writes; it contains no network logic.

import type { Config, Workspace, Account, PendingShot, PendingShots, Attachment, AiAuth, AiPendingAuth, EditorPrefs } from './types.js';
import type { StoragePort } from './ports.js';
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
  // Voice-input dictionary: terms sent as a transcription prompt to improve recognition.
  aiVocabulary: [],
  // Reasoning effort for AI generation ('off' | 'low' | 'medium' | 'high'). Off by default.
  aiReasoning: 'off',
  // Auto-start dictation when the Smart-dictation dialog opens.
  autoDictate: false,
  // Dictation language hint ('auto' = let the model detect it).
  dictationLang: 'auto',
  // Close the editor and switch back to the captured tab after a successful submit.
  closeAfterSubmit: true,
  // Allow a keyboard shortcut (configured at chrome://extensions/shortcuts) to capture. Off by default.
  shortcutEnabled: false,
  // Remembered selection: reused as the default the next time the editor opens.
  lastWorkspaceId: '',
  lastType: '',
};
export { DEFAULT_CONFIG };

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

// A module-level StoragePort is injected once at startup (see core/index.ts initCore).
let S: StoragePort | undefined;
export function bindStorage(port: StoragePort): void {
  S = port;
}
function store(): StoragePort {
  if (!S) throw new Error('storage not bound; call initCore() first');
  return S;
}

/** Read the full configuration, backfilling any missing fields with defaults + migrating. */
export async function getConfig(): Promise<Config> {
  const raw = await store().get<Partial<Config>>(CONFIG_KEY);
  const stored = raw ?? {};
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...stored,
    workspaces: Array.isArray(stored.workspaces) ? (stored.workspaces as Workspace[]) : [],
    accounts: Array.isArray(stored.accounts) ? (stored.accounts as Account[]) : [],
    types: Array.isArray(stored.types) && stored.types.length ? stored.types : DEFAULT_CONFIG.types.slice(),
    aiVocabulary: Array.isArray(stored.aiVocabulary) ? (stored.aiVocabulary as string[]) : [],
  };
  // First install (nothing stored yet, no explicit language): default to the system language.
  if (raw == null && stored.lang == null) merged.lang = detectLang();
  return migrateAccounts(merged);
}

/** Persist the full configuration. */
export async function setConfig(config: Config): Promise<void> {
  await store().set(CONFIG_KEY, config);
}

/** Update a subset of fields (read-modify-write). */
export async function patchConfig(patch: Partial<Config>): Promise<Config> {
  const config = await getConfig();
  const next = { ...config, ...patch };
  await setConfig(next);
  return next;
}

// Editor tool preferences (remembered color/stroke/thickness/font size). UI-only, kept under
// their own key so they never appear in configuration exports.
const EDITOR_PREFS_KEY = 'editorPrefs';
export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  color: '#ff3b30',
  strokeColor: '#ffffff',
  strokeWidth: 3,
  width: 4,
  fontSize: 28,
  tool: 'rect',
};
export async function getEditorPrefs(): Promise<EditorPrefs> {
  const stored = (await store().get<Partial<EditorPrefs>>(EDITOR_PREFS_KEY)) ?? {};
  return { ...DEFAULT_EDITOR_PREFS, ...stored };
}
export async function patchEditorPrefs(patch: Partial<EditorPrefs>): Promise<EditorPrefs> {
  const next = { ...(await getEditorPrefs()), ...patch };
  await store().set(EDITOR_PREFS_KEY, next);
  return next;
}

// The active Settings tab is UI-only and lives under its own key so it never appears in
// configuration exports.
const OPTIONS_TAB_KEY = 'optionsTab';
export async function getOptionsTab(): Promise<string> {
  return (await store().get<string>(OPTIONS_TAB_KEY)) || 'workspaces';
}
export async function setOptionsTab(tab: string): Promise<void> {
  await store().set(OPTIONS_TAB_KEY, tab);
}

/** Remember the current selection (called when the editor changes workspace/type). */
export async function rememberSelection({ workspaceId, type }: { workspaceId?: string; type?: string }): Promise<Config> {
  const patch: Partial<Config> = {};
  if (workspaceId !== undefined) patch.lastWorkspaceId = workspaceId;
  if (type !== undefined) patch.lastType = type;
  return patchConfig(patch);
}

// ---- Pending screenshots ----------------------------------------------------
//
// Written by the host when the icon/shortcut captures, read by the editor. Multiple
// attachments are staged together and edited as one issue. A legacy single-shot envelope
// (pendingShot) is migrated on read. They are cleared after submit and when the editor closes.
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
  const envelope = await store().get<PendingShots>(PENDING_SHOTS_KEY);
  if (envelope) return envelope;
  const legacy = await store().get<PendingShot>(PENDING_KEY);
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
  await store().set(PENDING_SHOTS_KEY, p);
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
  await store().remove(PENDING_SHOTS_KEY);
  await store().remove(PENDING_KEY);
}

// ---- AI assistant credentials -----------------------------------------------
//
// Stored under their own key, kept out of Config so configuration export/import never
// carries the access/refresh tokens. The pending PKCE state lives in session storage and
// is discarded when the flow completes (or the host restarts).
const AI_AUTH_KEY = 'aiAuth';
const AI_PENDING_KEY = 'aiPendingAuth';

/** Read the stored AI credentials, or null if the assistant is not connected. */
export async function getAiAuth(): Promise<AiAuth | null> {
  return (await store().get<AiAuth>(AI_AUTH_KEY)) ?? null;
}

/** Persist the AI credentials. */
export async function setAiAuth(auth: AiAuth): Promise<void> {
  await store().set(AI_AUTH_KEY, auth);
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
  await store().remove(AI_AUTH_KEY);
}

/** Stash the PKCE verifier/state while the user completes the OAuth flow. */
export async function setPendingAuth(pending: AiPendingAuth): Promise<void> {
  await store().session.set(AI_PENDING_KEY, pending);
}

/** Read the in-flight OAuth PKCE state. */
export async function getPendingAuth(): Promise<AiPendingAuth | null> {
  return (await store().session.get<AiPendingAuth>(AI_PENDING_KEY)) ?? null;
}

/** Discard the in-flight OAuth PKCE state. */
export async function clearPendingAuth(): Promise<void> {
  await store().session.remove(AI_PENDING_KEY);
}
