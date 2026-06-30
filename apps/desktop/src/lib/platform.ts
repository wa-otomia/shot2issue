// The desktop Platform adapter: the concrete implementation of @shot2issue/core's Platform
// port (http / storage / shell / oauth / now). main.tsx calls makePlatform() once and passes
// the result to initCore() before any view renders.
//
// Why each adapter is what it is:
//   - http  → @tauri-apps/plugin-http's fetch (Rust reqwest under the hood). On WKWebView
//             (macOS) the webview's own fetch is subject to CORS, so the cross-origin GitHub /
//             GitLab / YouTrack / ChatGPT calls the core makes would be blocked. plugin-http
//             runs in Rust and is CORS-immune; it returns a spec Response, so the core's
//             HttpResponse contract (ok/status/headers/text()/json()/body) is satisfied as a
//             near pass-through.
//   - storage → @tauri-apps/plugin-store (a persisted JSON file). The `session` sub-store is an
//             in-memory Map — it holds only the short-lived PKCE verifier/state between starting
//             and finishing an OAuth flow, and (extension parity) must be cleared on restart.
//   - shell.openExternal → plugin-shell open() (opens the system browser for the OAuth URL).
//   - oauth → invoke('oauth_loopback_start' / 'oauth_loopback_wait') against the Rust
//             127.0.0.1:1455 server (see src-tauri/src/services/oauth_loopback.rs).
//   - now   → Date.now.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { load, type Store } from "@tauri-apps/plugin-store";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import type {
  Platform,
  HttpFetch,
  HttpRequestInit,
  HttpResponse,
  StoragePort,
  ShellPort,
  OAuthLoopbackPort,
} from "@shot2issue/core";

// ---- http -------------------------------------------------------------------

// A default connect timeout so a hung TLS handshake can't wedge the UI forever. The core's
// HttpRequestInit headers are a plain Record<string,string>; the body is string | FormData |
// Blob | Uint8Array — all of which the spec fetch (and plugin-http's fetch) accept directly.
const CONNECT_TIMEOUT_MS = 30_000;

const httpFetch: HttpFetch = async (input: string, init?: HttpRequestInit): Promise<HttpResponse> => {
  const res = await tauriFetch(input, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body as BodyInit | undefined,
    signal: init?.signal,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  // plugin-http returns a spec Response, which already exposes the full HttpResponse surface
  // (ok, status, headers, text(), json(), body). Return it directly.
  return res as unknown as HttpResponse;
};

// ---- storage ----------------------------------------------------------------

// Persisted key/value file under the app data dir (shared with the Rust-side settings store
// name so there's one config file). Loaded lazily on first use.
const STORE_FILE = "settings.json";
let storePromise: Promise<Store> | undefined;
function persistent(): Promise<Store> {
  // No options: autoSave defaults to a 100ms-debounced write-through, so set()/delete() persist
  // without an explicit save(); the existing on-disk file is loaded as-is.
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

// In-memory session map: PKCE state only, cleared on restart (a fresh process = a fresh Map),
// matching chrome.storage.session semantics in the extension.
const sessionMap = new Map<string, unknown>();

const storage: StoragePort = {
  async get<T>(key: string): Promise<T | undefined> {
    return (await persistent()).get<T>(key);
  },
  async set<T>(key: string, value: T): Promise<void> {
    await (await persistent()).set(key, value);
  },
  async remove(key: string): Promise<void> {
    await (await persistent()).delete(key);
  },
  session: {
    async get<T>(key: string): Promise<T | undefined> {
      return sessionMap.has(key) ? (sessionMap.get(key) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      sessionMap.set(key, value);
    },
    async remove(key: string): Promise<void> {
      sessionMap.delete(key);
    },
  },
};

// ---- shell ------------------------------------------------------------------

const shell: ShellPort = {
  async openExternal(url: string): Promise<void> {
    await shellOpen(url);
  },
};

// ---- oauth loopback ---------------------------------------------------------

// The Rust 127.0.0.1:1455 server. `oauth_loopback_start` binds the listener and returns the
// exact redirect URI to advertise (http://localhost:1455/auth/callback — the only redirect the
// Codex client registers); `oauth_loopback_wait` resolves with the full callback URL once the
// browser hits /auth/callback. See src-tauri/src/services/oauth_loopback.rs.
const oauth: OAuthLoopbackPort = {
  async capture(): Promise<{ redirectUri: string; callbackUrl: Promise<string> }> {
    const redirectUri = await invoke<string>("oauth_loopback_start");
    // Don't await here: return the pending promise so the caller can open the browser first,
    // then await the callback. (The Rust side holds the captured URL once the listener fires.)
    const callbackUrl = invoke<string>("oauth_loopback_wait");
    return { redirectUri, callbackUrl };
  },
};

// ---- assembly ---------------------------------------------------------------

/** Build the desktop Platform. Call once at boot, before initCore(). */
export async function makePlatform(): Promise<Platform> {
  return {
    http: httpFetch,
    storage,
    shell,
    oauth,
    now: () => Date.now(),
  };
}
