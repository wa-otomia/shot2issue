// GitHub provider: files issues via the github.com web session (see page-upload.ts).

import { checkGithubLogin } from '../github-attach.js';
import { submitIssueViaPage } from '../page-upload.js';
import type { Provider, SubmitContext, TFunc } from './types.js';
import type { Workspace } from '../types.js';

export const githubProvider: Provider = {
  id: 'github',
  label: 'GitHub',
  fields: [
    { key: 'owner', labelKey: 'wsOwner', placeholder: 'octocat' },
    { key: 'repo', labelKey: 'wsRepo', placeholder: 'hello-world' },
  ],

  describe(ws: Workspace): string {
    return `${ws.owner || ''}/${ws.repo || ''}`;
  },

  validate(ws: Workspace): string | null {
    return !ws.owner || !ws.repo ? 'errWorkspaceNeedsOwnerRepo' : null;
  },

  normalize(ws: Workspace): Record<string, string> {
    return { owner: (ws.owner || '').trim(), repo: (ws.repo || '').trim() };
  },

  permissionOrigins(): string[] {
    return [];
  },

  async hint(_ws: Workspace, t: TFunc): Promise<{ text: string; ok: boolean }> {
    const { loggedIn, login } = await checkGithubLogin();
    return loggedIn
      ? { text: t('loginSignedInAs', [login]), ok: true }
      : { text: '⚠ ' + t('loginNotSignedIn'), ok: false };
  },

  async submit(ws: Workspace, ctx: SubmitContext) {
    ctx.busy('statusCheckingLogin');
    const { loggedIn } = await checkGithubLogin();
    if (!loggedIn) throw new Error(ctx.t('errNotSignedIn'));

    ctx.busy(ctx.withImage ? 'statusSubmitting' : 'statusSubmittingNoImage');
    const url = await submitIssueViaPage({
      owner: ws.owner,
      repo: ws.repo,
      title: ctx.title,
      body: ctx.body,
      dataUrl: ctx.dataUrl,
      filename: ctx.filename,
      withImage: ctx.withImage,
    });
    const m = url.match(/\/issues\/(\d+)/);
    return { url, number: m ? m[1] : '' };
  },
};
