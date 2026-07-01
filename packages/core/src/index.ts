// Core public surface + one-time platform injection.
//
// A host app (apps/extension or apps/desktop) calls initCore(platform) once at boot to
// inject its platform adapters. After that, every reused module (storage, ai, and the ported
// network clients) runs with no further wiring: storage goes through the StoragePort, network
// IO goes through the injected HttpFetch, and time comes from Platform.now.

import { bindHttp } from './net.js';
import { bindStorage } from './storage.js';
import { bindNow, bindOAuth, bindShell } from './ai/ai.js';
import type { Platform } from './ports.js';

/** Inject the host platform. Call once, before any storage/ai/network call. */
export function initCore(p: Platform): void {
  bindHttp(p.http);
  bindStorage(p.storage);
  bindNow(p.now);
  // The OAuth loopback + shell are only needed by the desktop's ai.connect(); both ports are
  // always present on the Platform, so bind them unconditionally (the extension passes no-ops).
  bindOAuth(p.oauth);
  bindShell(p.shell);
}

// Shared data types.
export * from './types.js';

// Storage over the StoragePort (config / editor prefs / pending shots / AI auth).
export * from './storage.js';

// AI assistant (OAuth helpers, model/quota/title/complaint flows). Re-exported under a
// namespace too, matching the './ai' export-map entry.
export * as ai from './ai/ai.js';

// i18n (the verbatim translation table + helpers).
export { t, setLanguage, localizeDom, detectLang, SUPPORTED_LANGS, DEFAULT_LANG, DICTATION_LANGS } from './i18n.js';

// Provider registry contract (impls are registered by the host; see ./providers).
export { PROVIDER_LIST, registerProviders, getProvider, isAccountBased, accountKinds } from './providers/index.js';
export type {
  Provider,
  ProviderField,
  ProviderAccount,
  SubmitContext,
  SubmitImage,
  TFunc,
} from './providers/types.js';

// The two pure-REST provider impls live in core (GitLab + YouTrack are platform-free once
// fetch is injected). GitHub stays host-owned (the extension uses chrome.scripting; the
// desktop uses Rust reqwest + the github.com session cookie), so it is NOT exported here.
export { gitlabProvider, createGitLabIssue } from './providers/gitlab.js';
export { youtrackProvider, createYouTrackIssue } from './providers/youtrack.js';

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
