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
  t: TFunc;
  busy: (key: string) => void;
}

/** One issue-tracker backend. See lib/providers/index.ts for the registry and docs. */
export interface Provider {
  id: string;
  label: string;
  fields: ProviderField[];
  hintKey?: string;
  describe(ws: Workspace): string;
  validate(ws: Workspace): string | null;
  normalize(ws: Workspace): Record<string, string>;
  permissionOrigins(ws: Workspace): string[];
  hint(ws: Workspace, t: TFunc): Promise<{ text: string; ok: boolean }>;
  submit(ws: Workspace, ctx: SubmitContext): Promise<IssueResult>;
}
