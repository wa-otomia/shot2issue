// Injected network transport. The reused clients (ai.ts, and later the gitlab/youtrack
// clients) import `fetch` from here instead of using the global, so the host decides the
// transport. Desktop binds it to a tauri-plugin-http wrapper (Rust reqwest); the extension
// binds it to window.fetch.

import type { HttpFetch, HttpResponse, HttpRequestInit } from './ports.js';

let impl: HttpFetch | undefined;
export function bindHttp(fn: HttpFetch): void {
  impl = fn;
}

/** Drop-in for the global fetch used by the ported clients. */
export function fetch(input: string, init?: HttpRequestInit): Promise<HttpResponse> {
  if (!impl) throw new Error('http transport not bound; call initCore() first');
  return impl(input, init);
}
