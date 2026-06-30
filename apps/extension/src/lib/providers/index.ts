// Issue-tracker provider registry.
//
// Each provider (see ./types.ts for the interface) implements one backend. The editor and
// the options page are backend-agnostic: they look a provider up by `workspace.kind` and
// call the interface. To add a backend, implement the Provider interface in a new module
// under src/lib/providers/ and add it to PROVIDER_LIST below.

import type { Provider } from './types.js';
import { githubProvider } from './github.js';
import { youtrackProvider } from './youtrack.js';
import { gitlabProvider } from './gitlab.js';

export type { Provider } from './types.js';

/** Registered providers, in the order shown in the target selector. */
export const PROVIDER_LIST: Provider[] = [githubProvider, youtrackProvider, gitlabProvider];

const BY_ID: Record<string, Provider> = Object.fromEntries(PROVIDER_LIST.map((p) => [p.id, p]));

/** Get a provider by kind; unknown or missing kinds fall back to the first (GitHub). */
export function getProvider(kind: string): Provider {
  return BY_ID[kind] || PROVIDER_LIST[0];
}

/** True for providers whose credentials live on an Account (youtrack, gitlab). */
export function isAccountBased(p: Provider): boolean {
  return !!(p.accountFields && p.accountFields.length);
}

/** Provider ids that use accounts — used to filter the Account-kind dropdown. */
export const accountKinds: string[] = PROVIDER_LIST.filter(isAccountBased).map((p) => p.id);
