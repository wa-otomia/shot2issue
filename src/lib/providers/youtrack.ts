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
  fields: [
    { key: 'baseUrl', labelKey: 'ytBaseUrl', placeholderKey: 'ytBaseUrlPlaceholder', full: true },
    { key: 'project', labelKey: 'ytProject', placeholderKey: 'ytProjectPlaceholder' },
    { key: 'token', labelKey: 'ytToken', type: 'password', placeholderKey: 'ytTokenPlaceholder' },
  ],
  hintKey: 'ytHint',

  describe(ws: Workspace): string {
    return `${ws.baseUrl || ''} ${ws.project || ''}`.trim() || 'YouTrack';
  },

  validate(ws: Workspace): string | null {
    return !ws.baseUrl || !ws.project || !ws.token ? 'errWorkspaceNeedsYouTrack' : null;
  },

  normalize(ws: Workspace): Record<string, string> {
    return {
      baseUrl: (ws.baseUrl || '').trim().replace(/\/+$/, ''),
      project: (ws.project || '').trim(),
      token: (ws.token || '').trim(),
    };
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
      dataUrl: ctx.dataUrl,
      filename: ctx.filename,
      withImage: ctx.withImage,
    });
  },
};
