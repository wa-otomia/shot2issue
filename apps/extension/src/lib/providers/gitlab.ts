// GitLab provider: files issues via the GitLab REST API (see gitlab.ts). Account-based —
// the baseUrl/token live on the bound Account; the workspace picks an account + project.

import { createGitLabIssue, ensureHostPermission } from '../gitlab.js';
import type { Provider, SubmitContext, TFunc } from './types.js';
import type { Workspace } from '../types.js';

function host(ws: Workspace): string {
  try {
    return new URL(ws.baseUrl).host;
  } catch {
    return ws.baseUrl || '';
  }
}

export const gitlabProvider: Provider = {
  id: 'gitlab',
  label: 'GitLab',
  fields: [],
  accountFields: [
    { key: 'baseUrl', labelKey: 'glBaseUrl', placeholderKey: 'glBaseUrlPlaceholder', full: true },
    { key: 'token', labelKey: 'glToken', type: 'password', placeholderKey: 'glTokenPlaceholder' },
  ],
  projectField: { key: 'project', labelKey: 'glProject', placeholderKey: 'glProjectPlaceholder' },
  hintKey: 'glHint',

  describe(ws: Workspace): string {
    return ws.project || 'GitLab';
  },

  // Validated against the MERGED workspace (account's baseUrl/token overlaid by the caller).
  validate(ws: Workspace): string | null {
    if (!ws.accountId) return 'errWorkspaceNeedsAccount';
    return !ws.baseUrl || !ws.project || !ws.token ? 'errWorkspaceNeedsGitLab' : null;
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
    return { text: t('glTarget', [host(ws)]), ok: true };
  },

  async submit(ws: Workspace, ctx: SubmitContext) {
    const granted = await ensureHostPermission(ws.baseUrl);
    if (!granted) throw new Error(ctx.t('errPermissionDenied', [host(ws)]));
    ctx.busy('statusSubmittingGitLab');
    return createGitLabIssue({
      baseUrl: ws.baseUrl,
      token: ws.token,
      project: ws.project,
      title: ctx.title,
      body: ctx.body,
      images: ctx.withImage ? ctx.images : [],
    });
  },
};
