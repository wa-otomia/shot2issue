// Core public surface + one-time platform injection.
//
// A host app (apps/extension or apps/desktop) calls initCore(platform) once at boot to
// inject its platform adapters. After that, every reused module (storage, ai, and the ported
// network clients) runs with no further wiring: storage goes through the StoragePort, network
// IO goes through the injected HttpFetch, and time comes from Platform.now.

import { bindHttp } from './net.js';
import { bindStorage } from './storage.js';
import { bindNow } from './ai/ai.js';
import type { Platform } from './ports.js';

/** Inject the host platform. Call once, before any storage/ai/network call. */
export function initCore(p: Platform): void {
  bindHttp(p.http);
  bindStorage(p.storage);
  bindNow(p.now);
}

// Shared data types.
export * from './types.js';

// Storage over the StoragePort (config / editor prefs / pending shots / AI auth).
export * from './storage.js';

// AI assistant (OAuth helpers, model/quota/title/complaint flows). Re-exported under a
// namespace too, matching the './ai' export-map entry.
export * as ai from './ai/ai.js';

// i18n (the verbatim translation table + helpers).
export { t, setLanguage, localizeDom, detectLang, SUPPORTED_LANGS, DEFAULT_LANG } from './i18n.js';

// Provider registry contract (impls are registered by the host; see ./providers).
export { PROVIDER_LIST, registerProviders, getProvider, isAccountBased, accountKinds } from './providers/index.js';
export type { Provider } from './providers/types.js';

// Canvas annotation engine (pure rendering + geometry), under a namespace to mirror './canvas'.
export * as canvas from './canvas/engine.js';

// Network seam (the injected fetch the ported clients import).
export { fetch as coreFetch, bindHttp } from './net.js';

// Ports (the adapter contract host apps implement).
export type {
  Platform,
  HttpFetch,
  HttpRequestInit,
  HttpResponse,
  StoragePort,
  ShellPort,
  OAuthLoopbackPort,
} from './ports.js';
