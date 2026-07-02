// YouTrack provider: create an issue and upload screenshots as attachments.
//
// Ported from apps/extension/src/lib/{youtrack,providers/youtrack}.ts. The REST logic is
// pure, so the only platform-coupling changes vs. the extension are:
//   - window.fetch / DOM Response → core's injected fetch / HttpResponse (from ../net);
//   - ensureHostPermission(chrome.permissions) is dropped (no per-origin grant on desktop).
// Account-based: the baseUrl/token live on the bound Account; the caller overlays them onto
// the workspace before submit() (extension parity).
//
// Unlike GitHub (whose issue attachments have no API), YouTrack offers a documented REST
// API for both, so this path uses a permanent token directly instead of a web session.
//
// Endpoints (https://www.jetbrains.com/help/youtrack/devportal/):
//   POST {base}/api/issues?fields=id,idReadable              body { project:{id}, summary, description }
//   POST {base}/api/issues/{id}/attachments?fields=id,name   multipart field name "upload"
//   POST {base}/api/issues/{id}?fields=id                   body { description }  (embed images)
// Authentication: Authorization: Bearer perm:...

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
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

function host(ws: Workspace): string {
  try {
    return new URL(ws.baseUrl).host;
  } catch {
    return ws.baseUrl || '';
  }
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
      const j = JSON.parse(raw) as {
        error_description?: unknown;
        error?: unknown;
        localizedMessage?: unknown;
        value?: unknown;
      };
      detail =
        (j.error_description as string) ||
        (j.error as string) ||
        (j.localizedMessage as string) ||
        (j.value as string) ||
        '';
    } catch {
      detail = raw.trim().slice(0, 300);
    }
  } catch {
    /* ignore */
  }
  return new Error(`${fallback} (HTTP ${resp.status})${detail ? ': ' + detail : ''}`);
}

/** A YouTrack project as returned by the admin projects endpoint. */
interface YouTrackProject {
  id: string;
  shortName?: string;
  name?: string;
}

/**
 * Resolve a project to its internal id. Accepts an internal id ("0-1") as-is; otherwise
 * looks it up by short name (then by name).
 */
async function resolveProjectId(baseUrl: string, token: string, project: string): Promise<string> {
  if (/^\d+-\d+$/.test(project)) return project;
  const url = api(baseUrl, `/api/admin/projects?fields=id,shortName,name&query=${encodeURIComponent(project)}`);
  const resp = await fetch(url, { headers: authHeaders(token) });
  if (!resp.ok) throw await toError(resp, 'Failed to look up the YouTrack project');
  const list = (await resp.json()) as YouTrackProject[];
  const lower = project.toLowerCase();
  const match =
    list.find((p) => (p.shortName || '').toLowerCase() === lower) ||
    list.find((p) => (p.name || '').toLowerCase() === lower);
  if (!match) {
    const candidates = list.map((p) => p.shortName || p.name || p.id).filter(Boolean);
    throw new Error(
      `YouTrack project not found: ${project}` +
        (candidates.length ? ` (candidates: ${candidates.join(', ')})` : '')
    );
  }
  return match.id;
}

/** A YouTrack issue as returned by the create endpoint. */
interface YouTrackIssue {
  id: string;
  idReadable?: string;
}

/** Create a YouTrack issue, optionally attaching the screenshots and embedding them inline. */
export async function createYouTrackIssue({
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
  const projectId = await resolveProjectId(baseUrl, token, project);

  // 1) Create the issue with the text body only. YouTrack can't create-and-attach in one call,
  //    and a `![](name)` reference only resolves once the attachment exists — so the image
  //    markdown is added afterwards (step 3), keyed off each attachment's real file URL.
  const createResp = await fetch(api(baseUrl, '/api/issues?fields=id,idReadable'), {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: { id: projectId }, summary: title, description: body || '' }),
  });
  if (!createResp.ok) throw await toError(createResp, 'Failed to create the YouTrack issue');
  const issue = (await createResp.json()) as YouTrackIssue;
  const idReadable = issue.idReadable || issue.id;

  // 2) Upload each attachment, capturing the name YouTrack actually stored it under.
  const names: string[] = [];
  for (const img of images) {
    const fd = new FormData();
    fd.append('upload', dataUrlToBlob(img.dataUrl), img.filename); // documented multipart field name
    const upResp = await fetch(
      api(baseUrl, `/api/issues/${encodeURIComponent(issue.id)}/attachments?fields=id,name`),
      { method: 'POST', headers: authHeaders(token), body: fd } // let the transport set the boundary
    );
    if (!upResp.ok) {
      throw await toError(upResp, `Issue ${idReadable} created, but uploading a screenshot failed`);
    }
    const att = (await upResp.json()) as { name?: string };
    names.push(att.name || img.filename); // YouTrack's stored name (handles any de-dup rename)
  }

  // 3) Now that every attachment EXISTS on the issue, embed each one inline by file name and
  //    update the description. YouTrack only resolves `![](name)` for files already attached to
  //    the issue, so referencing them in the create call (before upload) left all but the first
  //    un-inlined. Writing the references after upload makes every screenshot render inline.
  if (names.length) {
    const md = names.map((n) => `![${n}](${n})`).join('\n\n');
    const description = (body ? body.replace(/\s+$/, '') + '\n\n' : '') + md;
    const updResp = await fetch(api(baseUrl, `/api/issues/${encodeURIComponent(issue.id)}?fields=id`), {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    if (!updResp.ok) {
      throw await toError(updResp, `Issue ${idReadable} created, but embedding the screenshots failed`);
    }
  }

  return { url: api(baseUrl, `/issue/${idReadable}`), number: idReadable };
}

/** The registry Provider for YouTrack (account-based). */
export const youtrackProvider: Provider = {
  id: 'youtrack',
  label: 'YouTrack',
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
