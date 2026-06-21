// Optional AI assistant: sign in with an OpenAI Codex / ChatGPT-subscription account via
// OAuth (PKCE), then use the subscription to list models, read usage quota, and generate
// issue titles.
//
// Chrome extensions cannot run Codex's standard localhost callback, so two sign-in paths
// are offered:
//   1. Automatic — chrome.identity.launchWebAuthFlow with the extension's own
//      chromiumapp.org redirect. Works only if OpenAI accepts that redirect_uri.
//   2. Manual — open the authorize page with Codex's localhost redirect; after signing in
//      the browser lands on an unreachable localhost URL that carries ?code=…; the user
//      pastes that URL back and we finish the exchange.
//
// The pure helpers (PKCE, JWT/redirect/quota parsing, URL building, prompt) carry no
// dependency on chrome and are unit-tested directly.

import type { AiAuth, AiQuota } from './types.js';
import { getPendingAuth, setPendingAuth, clearPendingAuth, getAiAuth, setAiAuth } from './storage.js';

// ---- Constants (public Codex OAuth client) ---------------------------------
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const LOCALHOST_REDIRECT = 'http://localhost:1455/auth/callback';
export const SCOPES = 'openid profile email offline_access';
/** Sent as the originator with backend requests, matching the Codex CLI. */
export const ORIGINATOR = 'codex_cli_rs';
/** Subscription model calls go here (not api.openai.com, which needs an API key). */
export const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** Dynamic model list for Codex-with-ChatGPT (returns dotted slugs; no timestamps). */
export const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/**
 * Sent as the client_version query param to the models endpoint. The server gates which
 * models it returns by this version, so it must track a recent Codex CLI release — too old
 * a value caps the list (e.g. hides gpt-5.5). Bump this as new Codex releases ship.
 */
export const CODEX_CLIENT_VERSION = '0.141.0';
/** Origins the assistant needs; requested as optional host permissions on a gesture. */
export const AI_ORIGINS = ['https://auth.openai.com/*', 'https://chatgpt.com/*'];
/**
 * Models selectable with Codex when signed in with a ChatGPT account (mid-2026). Note the
 * dotted slugs: the consumer web /backend-api/models endpoint returns dashed slugs like
 * "gpt-5-5" that the Codex responses endpoint rejects, so this curated list is the source
 * of truth. gpt-5.5 is the recommended default; gpt-5.2 / gpt-5.3-codex are deprecated.
 */
export const DEFAULT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

/**
 * Release dates per model. The models endpoint carries no timestamps, so "added" dates come
 * from this curated changelog map and are shown in the model dropdown.
 */
export const MODEL_DATES: Record<string, string> = {
  'gpt-5.5': '2026-04-23',
  'gpt-5.4-mini': '2026-03-17',
  'gpt-5.4': '2026-03-05',
  'gpt-5.3-codex-spark': '2026-02-12',
};

/** A plausible Codex model slug: dotted (e.g. gpt-5.5), not a dashed web slug (gpt-5-5). */
export function isValidModelSlug(m: string): boolean {
  return DEFAULT_MODELS.includes(m) || /^gpt-\d+\.\d/.test(m);
}

/** Coerce a model to one of `allowed` (defaults to the curated list). */
export function normalizeModel(model?: string, allowed: string[] = DEFAULT_MODELS): string {
  const list = allowed.length ? allowed : DEFAULT_MODELS;
  return model && list.includes(model) ? model : list[0];
}

/** Parse the codex/models response into an ordered list of usable dotted slugs. */
export function parseModelsResponse(body: string): string[] {
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const arr = (Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : []) as Array<
      Record<string, unknown>
    >;
    const items = arr.filter(
      (m) => m && typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list')
    );
    items.sort((a, b) => ((a.priority as number) ?? 999) - ((b.priority as number) ?? 999));
    return items.map((m) => m.slug as string).filter(isValidModelSlug);
  } catch {
    return [];
  }
}

// ---- base64url + random ----------------------------------------------------
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  // Decode as UTF-8 so non-ASCII claims (e.g. names) survive.
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** A short opaque value used as the OAuth state parameter. */
export function randomState(): string {
  return bytesToBase64Url(randomBytes(24));
}

/** Generate a PKCE verifier and its S256 challenge. */
export async function genPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = bytesToBase64Url(randomBytes(64));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

// ---- Authorize URL + redirect parsing --------------------------------------
/** Build the OpenAI authorize URL for the given redirect URI and PKCE challenge. */
export function buildAuthorizeUrl(opts: { redirectUri: string; challenge: string; state: string }): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: opts.redirectUri,
    scope: SCOPES,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: ORIGINATOR,
    state: opts.state,
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

/**
 * Pull the authorization code (and state) out of whatever the user pastes back: a full
 * redirect URL, a bare query string, or a `code=…` fragment.
 */
export function parseRedirect(input: string): { code: string; state: string } {
  const raw = (input || '').trim();
  let query = '';
  if (raw.includes('://')) {
    const u = new URL(raw);
    query = u.search || u.hash.replace(/^#/, '');
  } else {
    query = raw.replace(/^[?#]/, '');
  }
  const params = new URLSearchParams(query);
  const err = params.get('error');
  if (err) throw new Error(params.get('error_description') || err);
  const code = params.get('code') || '';
  if (!code) throw new Error('No authorization code found in the pasted value.');
  return { code, state: params.get('state') || '' };
}

// ---- JWT (id_token) --------------------------------------------------------
/** Decode a JWT payload without verifying the signature. */
export function parseJwt(token: string): Record<string, unknown> {
  const part = (token || '').split('.')[1];
  if (!part) throw new Error('Malformed token.');
  return JSON.parse(base64UrlToString(part)) as Record<string, unknown>;
}

/** Extract the ChatGPT account id, plan, and email from an id_token. */
export function accountInfoFromIdToken(idToken: string): {
  accountId?: string;
  planType?: string;
  email?: string;
  userId?: string;
} {
  let claims: Record<string, unknown> = {};
  try {
    claims = parseJwt(idToken);
  } catch {
    return {};
  }
  const auth = (claims['https://api.openai.com/auth'] as Record<string, unknown>) || {};
  return {
    // Only the ChatGPT account id is a valid ChatGPT-Account-Id; do not substitute org id.
    accountId: (auth.chatgpt_account_id as string) || undefined,
    planType: (auth.chatgpt_plan_type as string) || undefined,
    userId: (auth.chatgpt_user_id as string) || undefined,
    email: (claims.email as string) || undefined,
  };
}

// ---- Quota (x-codex-* response headers) ------------------------------------
/** Collect x-codex-* usage headers into a quota snapshot, with a couple of conveniences. */
export function parseQuotaHeaders(headers: Headers, now: number): AiQuota | undefined {
  const raw: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith('x-codex')) raw[name.toLowerCase()] = value;
  });
  if (!Object.keys(raw).length) return undefined;
  const num = (substr: string): number | undefined => {
    for (const [k, v] of Object.entries(raw)) {
      if (k.includes(substr) && k.includes('percent')) {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) return n;
      }
    }
    return undefined;
  };
  return {
    raw,
    primaryUsedPercent: num('primary'),
    secondaryUsedPercent: num('secondary'),
    checkedAt: now,
  };
}

// ---- Title prompt + output extraction --------------------------------------
/** Built-in English default prompt; the UI passes a localized/configured one via i18n. */
export const DEFAULT_TITLE_PROMPT =
  'You write concise, specific issue titles. Read the report below and return ONLY the ' +
  'title: a single line, no surrounding quotes, no trailing punctuation, at most about ' +
  '80 characters. Write the title in the same language as the description.';

/**
 * Build the instructions + input for the title-generation request. `instructions` is the
 * configurable system prompt (defaults to the built-in English one).
 */
export function buildTitlePrompt(
  content: {
    type?: string;
    pageTitle?: string;
    pageUrl?: string;
    body?: string;
  },
  instructions: string = DEFAULT_TITLE_PROMPT
): { instructions: string; input: string } {
  const lines: string[] = [];
  if (content.type) lines.push(`Type: ${content.type}`);
  if (content.pageTitle) lines.push(`Page title: ${content.pageTitle}`);
  if (content.pageUrl) lines.push(`Page URL: ${content.pageUrl}`);
  if (content.body && content.body.trim()) lines.push(`\nDescription:\n${content.body.trim()}`);
  return { instructions, input: lines.join('\n') || 'No description provided.' };
}

/**
 * Build the Codex responses request body. The Codex backend requires `input` to be a LIST
 * of typed message items (a plain string is rejected with 400 "Input must be a list"),
 * unlike the standard Responses API which also accepts a string.
 */
export function buildResponsesRequest(opts: {
  model: string;
  instructions: string;
  input: string;
  images?: string[];
  stream?: boolean;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: opts.input }];
  for (const img of opts.images || []) {
    if (img) content.push({ type: 'input_image', image_url: img, detail: 'auto' });
  }
  return {
    model: opts.model,
    instructions: opts.instructions,
    input: [{ type: 'message', role: 'user', content }],
    store: false,
    stream: opts.stream !== false,
  };
}

/** Tidy a raw model response into a single-line title. */
export function cleanTitle(text: string): string {
  let s = (text || '').trim().split('\n')[0].trim();
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  s = s.replace(/[。.!！?？,，;；:：]+$/g, '').trim();
  return s.slice(0, 120);
}

/**
 * Extract output text from a Responses API reply — either the parsed JSON body or the raw
 * SSE stream the backend may return.
 */
export function extractOutputText(body: string, contentType: string): string {
  if (contentType.includes('event-stream') || /^event:|^data:/m.test(body)) {
    let acc = '';
    let finalText = '';
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(evt.type || '');
      if (type.endsWith('output_text.delta') && typeof evt.delta === 'string') acc += evt.delta;
      else if (type.endsWith('output_text.done') && typeof evt.text === 'string') finalText = evt.text;
      else if (type === 'response.completed' && evt.response) {
        const t = textFromResponseObject(evt.response as Record<string, unknown>);
        if (t) finalText = t;
      }
    }
    return finalText || acc;
  }
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (typeof json.output_text === 'string') return json.output_text;
    return textFromResponseObject(json);
  } catch {
    return '';
  }
}

function textFromResponseObject(resp: Record<string, unknown>): string {
  const output = (resp.output as Array<Record<string, unknown>>) || [];
  for (const item of output) {
    const content = (item.content as Array<Record<string, unknown>>) || [];
    for (const c of content) {
      if (typeof c.text === 'string' && (c.type === 'output_text' || !c.type)) return c.text;
    }
  }
  return '';
}

// ---- Token exchange --------------------------------------------------------
async function postToken(params: Record<string, string>): Promise<AiAuth> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      msg = (j.error_description as string) || (j.error as string) || msg;
    } catch {
      /* keep status */
    }
    throw new Error(`Token exchange failed: ${msg}`);
  }
  const data = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  const info = data.id_token ? accountInfoFromIdToken(data.id_token) : {};
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    accountId: info.accountId,
    planType: info.planType,
    email: info.email,
    expiresAt: data.expires_in ? nowMs() + data.expires_in * 1000 : undefined,
    connectedAt: nowMs(),
  };
}

/** Exchange an authorization code for tokens. */
export function exchangeCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<AiAuth> {
  return postToken({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: opts.verifier,
  });
}

/** Obtain a fresh access token from a refresh token. */
export function refreshTokens(refreshToken: string): Promise<AiAuth> {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
}

// `Date.now` is fine in the extension runtime (only workflow scripts forbid it).
function nowMs(): number {
  return Date.now();
}

// ---- High-level flows (chrome) ---------------------------------------------
function extensionRedirectUri(): string {
  return chrome.identity.getRedirectURL();
}

/** Ensure the assistant's host permissions are granted (call on a user gesture). */
export async function ensureAiPermissions(): Promise<boolean> {
  try {
    if (await chrome.permissions.contains({ origins: AI_ORIGINS })) return true;
    return await chrome.permissions.request({ origins: AI_ORIGINS });
  } catch {
    return false;
  }
}

/**
 * Try the automatic flow via launchWebAuthFlow with the extension's own redirect. Resolves
 * to the new auth on success; throws if OpenAI rejects the redirect or the user cancels —
 * the caller then falls back to {@link beginManualAuth}.
 */
export async function connectAuto(): Promise<AiAuth> {
  const redirectUri = extensionRedirectUri();
  const { verifier, challenge } = await genPkce();
  const state = randomState();
  const url = buildAuthorizeUrl({ redirectUri, challenge, state });
  const resultUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!resultUrl) throw new Error('Sign-in was cancelled.');
  const parsed = parseRedirect(resultUrl);
  if (parsed.state !== state) throw new Error('State mismatch; sign-in aborted.');
  const auth = await exchangeCode({ code: parsed.code, verifier, redirectUri });
  await finalizeAuth(auth);
  return auth;
}

/**
 * Start the manual flow: stash the PKCE state and return the authorize URL (using Codex's
 * localhost redirect) for the caller to open. Finish with {@link completeManualAuth}.
 */
export async function beginManualAuth(): Promise<{ url: string }> {
  const redirectUri = LOCALHOST_REDIRECT;
  const { verifier, challenge } = await genPkce();
  const state = randomState();
  await setPendingAuth({ verifier, state, redirectUri, createdAt: nowMs() });
  return { url: buildAuthorizeUrl({ redirectUri, challenge, state }) };
}

/** Finish the manual flow from the redirect URL the user pasted back. */
export async function completeManualAuth(pastedUrl: string): Promise<AiAuth> {
  const pending = await getPendingAuth();
  if (!pending) throw new Error('No sign-in in progress. Start again.');
  const parsed = parseRedirect(pastedUrl);
  if (parsed.state && pending.state && parsed.state !== pending.state) {
    throw new Error('State mismatch; the pasted link does not match this sign-in.');
  }
  const auth = await exchangeCode({ code: parsed.code, verifier: pending.verifier, redirectUri: pending.redirectUri });
  await clearPendingAuth();
  await finalizeAuth(auth);
  return auth;
}

/** Populate the model list and persist a freshly obtained auth. */
async function finalizeAuth(auth: AiAuth): Promise<void> {
  auth.models = await fetchModels(auth);
  auth.model = auth.models[0] || DEFAULT_MODELS[0];
  await setAiAuth(auth);
}

/** Refresh the access token if it is missing or about to expire; returns current auth. */
export async function ensureFreshAuth(auth: AiAuth): Promise<AiAuth> {
  const fresh = auth.expiresAt ? auth.expiresAt - nowMs() > 60_000 : true;
  if (fresh || !auth.refreshToken) return auth;
  try {
    const refreshed = await refreshTokens(auth.refreshToken);
    const merged: AiAuth = {
      ...auth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || auth.refreshToken,
      idToken: refreshed.idToken || auth.idToken,
      expiresAt: refreshed.expiresAt,
    };
    await setAiAuth(merged);
    return merged;
  } catch {
    return auth; // let the downstream call fail and prompt re-auth
  }
}

function authHeaders(auth: AiAuth): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    originator: ORIGINATOR,
  };
  if (auth.accountId) h['ChatGPT-Account-Id'] = auth.accountId;
  return h;
}

/**
 * Fetch the Codex-account model list from the codex/models endpoint (dotted slugs). Falls
 * back to the curated list on any failure. Note: the consumer /backend-api/models endpoint
 * returns dashed slugs (gpt-5-5) the responses endpoint rejects — this uses the codex one.
 */
export async function fetchModels(auth: AiAuth): Promise<string[]> {
  try {
    const res = await fetch(`${MODELS_URL}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`, {
      headers: { ...authHeaders(auth), Accept: 'application/json' },
    });
    if (!res.ok) return DEFAULT_MODELS.slice();
    const slugs = parseModelsResponse(await res.text());
    return slugs.length ? slugs : DEFAULT_MODELS.slice();
  } catch {
    return DEFAULT_MODELS.slice();
  }
}

/**
 * Generate an issue title from the report content. Returns the title and, when the backend
 * provides them, an updated quota snapshot. Refreshes the token first if needed.
 */
export async function generateTitle(
  content: { type?: string; pageTitle?: string; pageUrl?: string; body?: string; images?: string[] },
  opts?: { model?: string; instructions?: string }
): Promise<{ title: string; quota?: AiQuota; auth: AiAuth }> {
  let auth = await getAiAuth();
  if (!auth) throw new Error('Not connected. Sign in to the AI assistant in Settings.');
  auth = await ensureFreshAuth(auth);
  // Self-heal a stale/invalid stored model or list (e.g. legacy dashed "gpt-5-5" slugs) so
  // the saved state and the request use a valid Codex model; keep a valid fetched list.
  const sane = (auth.models || []).filter(isValidModelSlug);
  const allowed = sane.length ? sane : DEFAULT_MODELS;
  const model = normalizeModel(opts?.model || auth.model, allowed);
  if (model !== auth.model || sane.length !== (auth.models?.length ?? 0)) {
    auth = { ...auth, model, models: allowed.slice() };
    await setAiAuth(auth);
  }
  const { instructions, input } = buildTitlePrompt(content, opts?.instructions);
  const images = (content.images || []).filter(Boolean);

  const post = (withImages: boolean): Promise<Response> =>
    fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(buildResponsesRequest({ model, instructions, input, images: withImages ? images : undefined })),
    });

  // Send the screenshot for visual context; if the backend rejects image input, retry text-only.
  let res = await post(images.length > 0);
  let text = await res.text();
  if (!res.ok && images.length) {
    res = await post(false);
    text = await res.text();
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const e = j.error as Record<string, unknown> | string | undefined;
      msg = typeof e === 'string' ? e : ((e?.message as string) || (j.detail as string) || msg);
    } catch {
      /* keep status */
    }
    throw new Error(`Title generation failed: ${msg}`);
  }
  const quota = parseQuotaHeaders(res.headers, nowMs());
  const title = cleanTitle(extractOutputText(text, res.headers.get('content-type') || ''));
  if (!title) throw new Error('The model returned an empty title.');
  if (quota) await setAiAuth({ ...auth, quota });
  return { title, quota, auth };
}

// ---- Voice "Complaint": transcribe + write title and body ------------------
/** Subscription transcription endpoint (Codex Desktop's; OAuth-token only, no API key). */
export const TRANSCRIBE_URL = 'https://chatgpt.com/backend-api/transcribe';
export const TRANSCRIBE_MODEL = 'whisper-1';

export const DEFAULT_COMPLAINT_PROMPT =
  "You turn a user's spoken complaint and screenshots into a clear software issue. Write a " +
  'concise, specific title and a well-structured Markdown body (what happened, where it ' +
  'happened, steps if any, and expected vs. actual). Write in the same language as the ' +
  'complaint. Return ONLY a JSON object with string fields "title" and "body".';

/** Coerce the stored model to a valid one and persist any repair; returns [auth, model]. */
async function healModelFor(auth: AiAuth, override?: string): Promise<{ auth: AiAuth; model: string }> {
  const sane = (auth.models || []).filter(isValidModelSlug);
  const allowed = sane.length ? sane : DEFAULT_MODELS;
  const model = normalizeModel(override || auth.model, allowed);
  if (model !== auth.model || sane.length !== (auth.models?.length ?? 0)) {
    const next = { ...auth, model, models: allowed.slice() };
    await setAiAuth(next);
    return { auth: next, model };
  }
  return { auth, model };
}

/** Transcribe recorded audio using the ChatGPT subscription (no API key). */
export async function transcribeAudio(blob: Blob, filename = 'audio.webm'): Promise<string> {
  let auth = await getAiAuth();
  if (!auth) throw new Error('Not connected. Sign in to the AI assistant in Settings.');
  auth = await ensureFreshAuth(auth);
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('model', TRANSCRIBE_MODEL);
  const res = await fetch(TRANSCRIBE_URL, { method: 'POST', headers: authHeaders(auth), body: fd });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const e = j.error as Record<string, unknown> | string | undefined;
      msg = typeof e === 'string' ? e : ((e?.message as string) || (j.detail as string) || msg);
    } catch {
      /* keep status */
    }
    throw new Error(`Transcription failed: ${msg}`);
  }
  try {
    const j = JSON.parse(text) as { text?: string; transcript?: string };
    return (j.text || j.transcript || '').trim();
  } catch {
    return text.trim();
  }
}

/** Build the user input text for a complaint. */
export function buildComplaintInput(content: {
  transcript: string;
  type?: string;
  pageTitle?: string;
  pageUrl?: string;
}): string {
  const lines: string[] = [];
  if (content.type) lines.push(`Type: ${content.type}`);
  if (content.pageTitle) lines.push(`Page title: ${content.pageTitle}`);
  if (content.pageUrl) lines.push(`Page URL: ${content.pageUrl}`);
  lines.push(`\nSpoken complaint:\n${(content.transcript || '').trim()}`);
  return lines.join('\n');
}

/** Build a responses request that asks for a structured {title, body} JSON object. */
export function buildComplaintRequest(opts: {
  model: string;
  instructions: string;
  input: string;
  images?: string[];
  schema?: boolean;
}): Record<string, unknown> {
  const req = buildResponsesRequest({ model: opts.model, instructions: opts.instructions, input: opts.input, images: opts.images });
  if (opts.schema) {
    req.text = {
      format: {
        type: 'json_schema',
        name: 'issue',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'body'],
          properties: { title: { type: 'string' }, body: { type: 'string' } },
        },
      },
    };
  }
  return req;
}

/** Parse the model's reply into {title, body}, tolerating non-JSON output. */
export function parseComplaintOutput(text: string): { title: string; body: string } {
  const tryParse = (s: string): { title?: unknown; body?: unknown } | null => {
    try {
      return JSON.parse(s) as { title?: unknown; body?: unknown };
    } catch {
      return null;
    }
  };
  let obj = tryParse(text.trim());
  if (!obj) {
    const m = text.match(/\{[\s\S]*\}/); // first {...} block
    if (m) obj = tryParse(m[0]);
  }
  if (obj && typeof obj.title === 'string' && typeof obj.body === 'string') {
    return { title: cleanTitle(obj.title), body: obj.body.trim() };
  }
  // Fallback: first line = title, the rest = body.
  const lines = text.trim().split('\n');
  return { title: cleanTitle(lines[0] || ''), body: lines.slice(1).join('\n').trim() };
}

/**
 * From a transcript (+ screenshots + metadata) write an issue title and body. Tries
 * structured JSON output with images, degrading to plain output and/or text-only if the
 * backend rejects either.
 */
export async function generateComplaint(
  content: { transcript: string; type?: string; pageTitle?: string; pageUrl?: string; images?: string[] },
  opts?: { model?: string; instructions?: string }
): Promise<{ title: string; body: string; quota?: AiQuota; auth: AiAuth }> {
  const base = await getAiAuth();
  if (!base) throw new Error('Not connected. Sign in to the AI assistant in Settings.');
  const fresh = await ensureFreshAuth(base);
  const { auth, model } = await healModelFor(fresh, opts?.model);
  const instructions = opts?.instructions || DEFAULT_COMPLAINT_PROMPT;
  const input = buildComplaintInput(content);
  const images = (content.images || []).filter(Boolean);

  const post = (withImages: boolean, schema: boolean): Promise<Response> =>
    fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(buildComplaintRequest({ model, instructions, input, images: withImages ? images : undefined, schema })),
    });

  // Preference order: images+schema → images → text-only. First OK wins.
  const attempts: Array<[boolean, boolean]> = images.length ? [[true, true], [true, false], [false, false]] : [[false, true], [false, false]];
  let res: Response | null = null;
  let text = '';
  let lastErr = '';
  for (const [withImages, schema] of attempts) {
    res = await post(withImages, schema);
    text = await res.text();
    if (res.ok) break;
    lastErr = parseResponsesError(text, res.status);
  }
  if (!res || !res.ok) throw new Error(`Complaint generation failed: ${lastErr}`);

  const quota = parseQuotaHeaders(res.headers, nowMs());
  const out = parseComplaintOutput(extractOutputText(text, res.headers.get('content-type') || ''));
  if (!out.title && !out.body) throw new Error('The model returned an empty result.');
  if (quota) await setAiAuth({ ...auth, quota });
  return { ...out, quota, auth };
}

function parseResponsesError(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error as Record<string, unknown> | string | undefined;
    return typeof e === 'string' ? e : ((e?.message as string) || (j.detail as string) || `HTTP ${status}`);
  } catch {
    return `HTTP ${status}`;
  }
}
