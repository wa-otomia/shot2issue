// GitLab REST API client: create an issue and upload screenshots as project uploads.
//
// Endpoints (https://docs.gitlab.com/api/):
//   POST {base}/api/v4/projects/{id}/uploads   multipart field "file"  -> { markdown, url, ... }
//   POST {base}/api/v4/projects/{id}/issues     JSON { title, description }
// Auth: header  PRIVATE-TOKEN: <personal access token>  (PAT needs the "api" scope).
// {id} is a numeric project id, or the URL-encoded full path (group/sub/project -> %2F).
// Uploads are project-scoped, so each image must be uploaded to the SAME project as the
// issue; the upload response's project-relative `markdown` is embedded in the description.

import type { IssueResult } from './types.js';

function trimBase(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function api(baseUrl: string, path: string): string {
  return trimBase(baseUrl) + path;
}

function authHeaders(token: string): Record<string, string> {
  return { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
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

async function toError(resp: Response, fallback: string): Promise<Error> {
  let detail = '';
  try {
    const j = (await resp.json()) as { message?: unknown; error?: unknown; error_description?: unknown };
    const m = j.message;
    detail =
      (typeof m === 'string' ? m : m ? JSON.stringify(m) : '') ||
      (j.error_description as string) ||
      (j.error as string) ||
      '';
  } catch {
    try {
      detail = (await resp.text()).slice(0, 160);
    } catch {
      /* ignore */
    }
  }
  return new Error(`${fallback} (HTTP ${resp.status})${detail ? ': ' + detail : ''}`);
}

/**
 * Ensure the extension has host permission for the GitLab origin. Must be called from a
 * user gesture. Returns true if granted.
 */
export async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  const origin = new URL(trimBase(baseUrl)).origin + '/*';
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
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
      headers: authHeaders(token), // no Content-Type — the browser sets the multipart boundary
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
