// YouTrack provider: files issues via the YouTrack REST API (see youtrack.ts).

import { createYouTrackIssue, ensureHostPermission } from '../youtrack.js';
import type { Provider, SubmitContext, TFunc } from './types.js';
import type { Workspace } from '../types.js';

function host(ws: Workspace): string {
  try {
    return new URL(ws.baseUrl).host;
  } catch {
    return ws.baseUrl || '';
  }
}

export const youtrackProvider: Provider = {
  id: 'youtrack',
  label: 'YouTrack',
  // Account-based: baseUrl/token live on the Account; the workspace picks an account + project.
  fields: [],
  accountFields: [
    { key: 'baseUrl', labelKey: 'ytBaseUrl', placeholderKey: 'ytBaseUrlPlaceholder', full: true },
    { key: 'token', labelKey: 'ytToken', type: 'password', placeholderKey: 'ytTokenPlaceholder' },
  ],
  projectField: { key: 'project', labelKey: 'ytProject', placeholderKey: 'ytProjectPlaceholder' },
  hintKey: 'ytHint',

  describe(ws: Workspace): string {
    return ws.project || 'YouTrack';
  },

  // Validated against the MERGED workspace (account's baseUrl/token overlaid by the caller).
  validate(ws: Workspace): string | null {
    if (!ws.accountId) return 'errWorkspaceNeedsAccount';
    return !ws.baseUrl || !ws.project || !ws.token ? 'errWorkspaceNeedsYouTrack' : null;
  },

  normalize(ws: Workspace): Record<string, string> {
    return { accountId: ws.accountId || '', project: (ws.project || '').trim() };
  },

  permissionOrigins(ws: Workspace): string[] {
    try {
      return [new URL(ws.baseUrl).origin + '/*'];
    } catch {
      return [];
    }
  },

  async hint(ws: Workspace, t: TFunc): Promise<{ text: string; ok: boolean }> {
    return { text: t('ytTarget', [host(ws)]), ok: true };
  },

  async submit(ws: Workspace, ctx: SubmitContext) {
    const granted = await ensureHostPermission(ws.baseUrl);
    if (!granted) throw new Error(ctx.t('errPermissionDenied', [host(ws)]));
    ctx.busy('statusSubmittingYouTrack');
    return createYouTrackIssue({
      baseUrl: ws.baseUrl,
      token: ws.token,
      project: ws.project,
      title: ctx.title,
      body: ctx.body,
      images: ctx.withImage ? ctx.images : [],
    });
  },
};
