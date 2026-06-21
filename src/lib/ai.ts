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
/** Origins the assistant needs; requested as optional host permissions on a gesture. */
export const AI_ORIGINS = ['https://auth.openai.com/*', 'https://chatgpt.com/*'];
/**
 * Models selectable with Codex when signed in with a ChatGPT account (mid-2026). Note the
 * dotted slugs: the consumer web /backend-api/models endpoint returns dashed slugs like
 * "gpt-5-5" that the Codex responses endpoint rejects, so this curated list is the source
 * of truth. gpt-5.5 is the recommended default; gpt-5.2 / gpt-5.3-codex are deprecated.
 */
export const DEFAULT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

/** Coerce a possibly-stale or web-form model slug to a valid Codex model. */
export function normalizeModel(model?: string): string {
  return model && DEFAULT_MODELS.includes(model) ? model : DEFAULT_MODELS[0];
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
/** Build the instructions + input for the title-generation request. */
export function buildTitlePrompt(content: {
  type?: string;
  pageTitle?: string;
  pageUrl?: string;
  body?: string;
}): { instructions: string; input: string } {
  const instructions =
    'You write concise, specific issue titles. Read the report below and return ONLY the ' +
    'title: a single line, no surrounding quotes, no trailing punctuation, at most about ' +
    '80 characters. Write the title in the same language as the description.';
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
  stream?: boolean;
}): Record<string, unknown> {
  return {
    model: opts.model,
    instructions: opts.instructions,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: opts.input }] }],
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
 * The list of Codex-account models. The consumer https://chatgpt.com/backend-api/models
 * endpoint returns dashed consumer slugs (e.g. "gpt-5-5") that the Codex responses endpoint
 * rejects with HTTP 400, so we return the curated dotted list. A dynamic Codex models
 * endpoint (with per-model timestamps) is being wired in a follow-up.
 */
export async function fetchModels(_auth: AiAuth): Promise<string[]> {
  return DEFAULT_MODELS.slice();
}

/**
 * Generate an issue title from the report content. Returns the title and, when the backend
 * provides them, an updated quota snapshot. Refreshes the token first if needed.
 */
export async function generateTitle(
  content: { type?: string; pageTitle?: string; pageUrl?: string; body?: string },
  opts?: { model?: string }
): Promise<{ title: string; quota?: AiQuota; auth: AiAuth }> {
  let auth = await getAiAuth();
  if (!auth) throw new Error('Not connected. Sign in to the AI assistant in Settings.');
  auth = await ensureFreshAuth(auth);
  const model = normalizeModel(opts?.model || auth.model);
  // Self-heal a stale/invalid stored model or list (e.g. a web "gpt-5-5" slug) so the
  // saved state and the request both use a valid Codex model.
  const storedBad = normalizeModel(auth.model) !== auth.model || !auth.models || auth.models.some((m) => !DEFAULT_MODELS.includes(m));
  if (storedBad) {
    auth = { ...auth, model: normalizeModel(auth.model), models: DEFAULT_MODELS.slice() };
    await setAiAuth(auth);
  }
  const { instructions, input } = buildTitlePrompt(content);
  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { ...authHeaders(auth), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(buildResponsesRequest({ model, instructions, input })),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const e = j.error as Record<string, unknown> | string | undefined;
      msg = typeof e === 'string' ? e : ((e?.message as string) || msg);
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
