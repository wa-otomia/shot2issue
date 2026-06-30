// Issue-tracker provider registry.
//
// Each provider (see ./types.ts for the interface) implements one backend. The editor and
// the options page are backend-agnostic: they look a provider up by `workspace.kind` and
// call the interface. To add a backend, implement the Provider interface in a new module
// and register it via registerProviders() below.
//
// NOTE (phase 2 extraction): the provider IMPLEMENTATIONS are intentionally NOT part of the
// shared core yet. The extension's GitHub provider relies on chrome.scripting (which has no
// platform-free or Tauri analogue) and the YouTrack/GitLab clients use chrome.permissions;
// each host therefore owns its provider impls and registers them at boot. The desktop
// GitHub provider is a PAT REST/GraphQL rewrite (see the editor-reuse-upload blueprint).
// The registry surface below is the stable contract both hosts share.

import type { Provider } from './types.js';

export type { Provider } from './types.js';

/** Registered providers, in the order shown in the target selector. Populated by the host. */
export const PROVIDER_LIST: Provider[] = [];

let BY_ID: Record<string, Provider> = {};

/** Register the host's provider implementations (idempotent; replaces any prior set). */
export function registerProviders(providers: Provider[]): void {
  PROVIDER_LIST.length = 0;
  PROVIDER_LIST.push(...providers);
  BY_ID = Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p]));
}

/** Get a provider by kind; unknown or missing kinds fall back to the first (GitHub). */
export function getProvider(kind: string): Provider {
  return BY_ID[kind] || PROVIDER_LIST[0];
}

/** True for providers whose credentials live on an Account (youtrack, gitlab). */
export function isAccountBased(p: Provider): boolean {
  return !!(p.accountFields && p.accountFields.length);
}

/** Provider ids that use accounts — used to filter the Account-kind dropdown. */
export function accountKinds(): string[] {
  return PROVIDER_LIST.filter(isAccountBased).map((p) => p.id);
}
