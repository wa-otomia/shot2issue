// Provider interface shared by all issue-tracker backends.

import type { Workspace, IssueResult } from '../types.js';

/** Translation function (see lib/i18n.ts). */
export type TFunc = (key: string, subs?: string | number | Array<string | number>) => string;

/** A backend-specific configuration field rendered in the options workspace card. */
export interface ProviderField {
  key: string;
  labelKey: string;
  type?: 'text' | 'password';
  placeholder?: string;
  placeholderKey?: string;
  full?: boolean;
}

/** One screenshot to attach, with the filename it should be uploaded under. */
export interface SubmitImage {
  dataUrl: string;
  filename: string;
}

/** Resolved account credentials passed to an account-based provider's submit(). */
export interface ProviderAccount {
  id: string;
  kind: string;
  baseUrl: string;
  token: string;
}

/** Context passed to a provider's submit(). */
export interface SubmitContext {
  title: string;
  body: string;
  /** All screenshots to embed, in order. Empty when submitting without images. */
  images: SubmitImage[];
  /** Whether to attach the screenshots at all. */
  withImage: boolean;
  /** First image, kept for back-compat with single-image call sites. */
  dataUrl: string;
  filename: string;
  /**
   * Resolved Account for account-based providers (undefined for github). The caller also
   * overlays the account's baseUrl/token onto the workspace before calling submit, so a
   * provider can read either; this is the canonical source.
   */
  account?: ProviderAccount;
  t: TFunc;
  busy: (key: string) => void;
}

/** One issue-tracker backend. See lib/providers/index.ts for the registry and docs. */
export interface Provider {
  id: string;
  label: string;
  /** Per-workspace fields rendered on the workspace card (e.g. GitHub owner/repo). */
  fields: ProviderField[];
  /**
   * Non-empty for account-based providers (youtrack, gitlab): credential fields rendered on
   * the Account card (e.g. baseUrl/token). The workspace then only picks an account + project.
   */
  accountFields?: ProviderField[];
  /**
   * True for cookie/session account-based providers (desktop github): the account lives in the
   * unified account list and is picked per-workspace, but its Account card renders a Sign-in
   * button (a web session) instead of token fields, so accountFields is empty. isAccountBased()
   * treats such a provider as account-based even though accountFields has no entries.
   */
  cookieAuth?: boolean;
  /** The per-workspace project field for account-based providers. */
  projectField?: ProviderField;
  hintKey?: string;
  describe(ws: Workspace): string;
  validate(ws: Workspace): string | null;
  normalize(ws: Workspace): Record<string, string>;
  permissionOrigins(ws: Workspace): string[];
  hint(ws: Workspace, t: TFunc): Promise<{ text: string; ok: boolean }>;
  submit(ws: Workspace, ctx: SubmitContext): Promise<IssueResult>;
}
