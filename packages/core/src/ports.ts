// Platform-capability ports. The core never imports chrome.* or @tauri-apps;
// it receives an implementation of these interfaces from the host app.

import type { Config, AiAuth, AiPendingAuth, EditorPrefs, PendingShots } from './types.js';

/**
 * Minimal fetch the core needs. Signature is a deliberate subset of the DOM
 * `fetch` so the extension can pass `window.fetch` verbatim, while the desktop
 * passes a wrapper over tauri-plugin-http (Rust reqwest) — required because
 * WKWebView blocks cross-origin webview fetches (CORS). The response must
 * expose: ok, status, text(), json(), headers.get()/forEach(), and a readable
 * body (or null). tauri-plugin-http's fetch returns a spec Response, so the
 * desktop adapter is a thin pass-through plus a default { connectTimeout }.
 */
export type HttpFetch = (input: string, init?: HttpRequestInit) => Promise<HttpResponse>;

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData | Blob | Uint8Array;
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}

/** Key/value persistence. Extension → chrome.storage.local; desktop → tauri-plugin-store. */
export interface StoragePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Session-scoped (cleared on restart): PKCE state. Desktop maps it to an in-memory map. */
  session: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

/** Opening external URLs / the OAuth browser. Extension → chrome.tabs; desktop → plugin-shell open(). */
export interface ShellPort {
  openExternal(url: string): Promise<void>;
}

/**
 * The OAuth loopback. The extension implements this by opening a tab and
 * watching chrome.tabs.onUpdated for the localhost:1455 ?code=. The desktop
 * implements it with a Rust 127.0.0.1:1455 server (see oauth_loopback.rs):
 * capture() returns the redirect URI + a promise that resolves with the captured
 * callback URL once the browser hits /auth/callback.
 */
export interface OAuthLoopbackPort {
  /** Begin listening; returns the redirect URI to embed in the authorize URL and
   *  a promise resolving to the full callback URL (with ?code=&state=). */
  capture(): Promise<{ redirectUri: string; callbackUrl: Promise<string> }>;
}

/** Everything the core's high-level flows need from the host, bundled. */
export interface Platform {
  http: HttpFetch;
  storage: StoragePort;
  shell: ShellPort;
  oauth: OAuthLoopbackPort;
  now(): number;
}

export type { Config, AiAuth, AiPendingAuth, EditorPrefs, PendingShots };
