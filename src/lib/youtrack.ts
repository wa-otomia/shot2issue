// YouTrack REST API client: create an issue and upload the screenshot as an attachment.
//
// Unlike GitHub (whose issue attachments have no API), YouTrack offers a documented REST
// API for both, so this path uses a permanent token directly instead of a web session.
//
// Endpoints (https://www.jetbrains.com/help/youtrack/devportal/):
//   POST {base}/api/issues?fields=id,idReadable        body { project:{id}, summary, description }
//   POST {base}/api/issues/{id}/attachments?fields=id,name   multipart field name "upload"
// Authentication: Authorization: Bearer perm:...

import type { IssueResult } from "./types.js";

function trimBase(baseUrl: string): string {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function api(baseUrl: string, path: string): string {
  return trimBase(baseUrl) + path;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/** Decode a data: URL into a Blob (no fetch, so no CSP concerns). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const mime = (dataUrl.slice(0, comma).match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(dataUrl.slice(comma + 1));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function toError(resp: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const j = (await resp.json()) as {
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
      "";
  } catch (_) {
    try {
      detail = (await resp.text()).slice(0, 160);
    } catch (__) {
      /* ignore */
    }
  }
  return new Error(`${fallback} (HTTP ${resp.status})${detail ? ": " + detail : ""}`);
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
  if (!resp.ok) throw await toError(resp, "Failed to look up the YouTrack project");
  const list = (await resp.json()) as YouTrackProject[];
  const lower = project.toLowerCase();
  const match =
    list.find((p) => (p.shortName || "").toLowerCase() === lower) ||
    list.find((p) => (p.name || "").toLowerCase() === lower) ||
    list[0];
  if (!match) throw new Error(`YouTrack project not found: ${project}`);
  return match.id;
}

/**
 * Ensure the extension has host permission for the YouTrack origin. Must be called from a
 * user gesture (the request prompt requires one). Returns true if granted.
 */
export async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  const origin = new URL(trimBase(baseUrl)).origin + "/*";
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

/** A YouTrack issue as returned by the create endpoint. */
interface YouTrackIssue {
  id: string;
  idReadable?: string;
}

/**
 * Create a YouTrack issue, optionally attaching the screenshot and embedding it inline.
 */
export async function createYouTrackIssue({
  baseUrl,
  token,
  project,
  title,
  body,
  dataUrl,
  filename,
  withImage,
}: {
  baseUrl: string;
  token: string;
  project: string;
  title: string;
  body: string;
  dataUrl: string;
  filename: string;
  withImage: boolean;
}): Promise<IssueResult> {
  const projectId = await resolveProjectId(baseUrl, token, project);

  // Embed the image by attachment file name; YouTrack markdown resolves it once the
  // attachment is uploaded to the same issue below.
  let description = body || "";
  if (withImage && filename) {
    description = (description ? description.replace(/\s+$/, "") + "\n\n" : "") + `![${filename}](${filename})`;
  }

  const createResp = await fetch(api(baseUrl, "/api/issues?fields=id,idReadable"), {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ project: { id: projectId }, summary: title, description }),
  });
  if (!createResp.ok) throw await toError(createResp, "Failed to create the YouTrack issue");
  const issue = (await createResp.json()) as YouTrackIssue;
  const idReadable = issue.idReadable || issue.id;

  if (withImage && dataUrl) {
    const fd = new FormData();
    fd.append("upload", dataUrlToBlob(dataUrl), filename); // documented multipart field name
    const upResp = await fetch(
      api(baseUrl, `/api/issues/${encodeURIComponent(issue.id)}/attachments?fields=id,name`),
      { method: "POST", headers: authHeaders(token), body: fd } // let the browser set the multipart boundary
    );
    if (!upResp.ok) {
      throw await toError(upResp, `Issue ${idReadable} created, but uploading the screenshot failed`);
    }
  }

  return { url: api(baseUrl, `/issue/${idReadable}`), number: idReadable };
}
