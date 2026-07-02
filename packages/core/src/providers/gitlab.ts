// GitLab provider: create an issue and upload screenshots as project uploads.
//
// Ported from apps/extension/src/lib/{gitlab,providers/gitlab}.ts. The REST logic is pure,
// so the only platform-coupling changes vs. the extension are:
//   - window.fetch / DOM Response → core's injected fetch / HttpResponse (from ../net), so
//     transport is host-decided (desktop = Rust reqwest, which is CORS-immune on WKWebView);
//   - ensureHostPermission(chrome.permissions) is dropped — desktop has no per-origin grant,
//     and the http capability allowlist in tauri.conf already scopes which origins are reachable.
// Account-based: the baseUrl/token live on the bound Account; the workspace picks an
// account + project. The caller overlays the account's baseUrl/token onto the workspace
// before calling submit(), so reading ws.baseUrl/ws.token here is correct (extension parity).
//
// Endpoints (https://docs.gitlab.com/api/):
//   POST {base}/api/v4/projects/{id}/uploads   multipart field "file"  -> { markdown, url, ... }
//   POST {base}/api/v4/projects/{id}/issues     JSON { title, description }
// Auth: header  PRIVATE-TOKEN: <personal access token>  (PAT needs the "api" scope).
// {id} is a numeric project id, or the URL-encoded full path (group/sub/project -> %2F).

import { fetch } from '../net.js';
import type { HttpResponse } from '../ports.js';
import type { IssueResult, Workspace } from '../types.js';
import type { Provider, SubmitContext, TFunc } from './types.js';

function trimBase(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function api(baseUrl: string, path: string): string {
  return trimBase(baseUrl) + path;
}

function authHeaders(token: string): Record<string, string> {
  return { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
}

function host(ws: Workspace): string {
  try {
    return new URL(ws.baseUrl).host;
  } catch {
    return ws.baseUrl || '';
  }
}

/** Project id for the path: numeric id as-is, else URL-encode the full path (/ -> %2F). */
export function encodeProjectId(project: string): string {
  const p = String(project || '').trim();
  return /^\d+$/.test(p) ? p : encodeURIComponent(p);
}

/** Decode a data: URL into a Blob (no fetch, so no CSP concerns). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = (dataUrl.slice(0, comma).match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function toError(resp: HttpResponse, fallback: string): Promise<Error> {
  let detail = '';
  try {
    const raw = await resp.text();
    try {
      const j = JSON.parse(raw) as { message?: unknown; error?: unknown; error_description?: unknown };
      const m = j.message;
      detail =
        (typeof m === 'string' ? m : m ? JSON.stringify(m) : '') ||
        (j.error_description as string) ||
        (j.error as string) ||
        '';
    } catch {
      detail = raw.trim().slice(0, 300);
    }
  } catch {
    /* ignore */
  }
  return new Error(`${fallback} (HTTP ${resp.status})${detail ? ': ' + detail : ''}`);
}

interface GitLabIssue {
  iid: number;
  id: number;
  web_url?: string;
}

interface GitLabUpload {
  markdown?: string;
  url?: string;
  alt?: string;
}

/** Create a GitLab issue, uploading each screenshot to the project and embedding it inline. */
export async function createGitLabIssue({
  baseUrl,
  token,
  project,
  title,
  body,
  images,
}: {
  baseUrl: string;
  token: string;
  project: string;
  title: string;
  body: string;
  images: Array<{ dataUrl: string; filename: string }>;
}): Promise<IssueResult> {
  const idEnc = encodeProjectId(project);

  // 1) Upload each image to the project (uploads are project-scoped) and collect markdown.
  const md: string[] = [];
  for (const img of images) {
    const fd = new FormData();
    fd.append('file', dataUrlToBlob(img.dataUrl), img.filename); // documented field name "file"
    const upResp = await fetch(api(baseUrl, `/api/v4/projects/${idEnc}/uploads`), {
      method: 'POST',
      headers: authHeaders(token), // no Content-Type — the transport sets the multipart boundary
      body: fd,
    });
    if (!upResp.ok) throw await toError(upResp, 'Failed to upload a screenshot to GitLab');
    const up = (await upResp.json()) as GitLabUpload;
    if (up.markdown) md.push(up.markdown);
    else if (up.url) md.push(`![${img.filename}](${up.url})`);
  }

  // 2) Create the issue with the images embedded in the description.
  let description = body || '';
  if (md.length) description = (description ? description.replace(/\s+$/, '') + '\n\n' : '') + md.join('\n\n');

  const createResp = await fetch(api(baseUrl, `/api/v4/projects/${idEnc}/issues`), {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  if (!createResp.ok) throw await toError(createResp, 'Failed to create the GitLab issue');
  const issue = (await createResp.json()) as GitLabIssue;

  const url = issue.web_url || api(baseUrl, `/${project}/-/issues/${issue.iid}`);
  return { url, number: String(issue.iid ?? '') };
}

/** The registry Provider for GitLab (account-based). */
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
