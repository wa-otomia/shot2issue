// GitHub provider (desktop): files issues via the user's github.com WEB SESSION cookie — no
// OAuth, no PAT. The single `user_session` cookie obtained by the built-in GitHub-login
// webview (see src-tauri/src/services/github.rs) drives BOTH image upload and issue creation.
//
// Why cookies for everything: GitHub's user-attachments upload endpoints
// (/upload/policies/assets, the S3 presign, /upload/assets/{id}) are web-session-only — an
// OAuth or PAT token is rejected there. So a token-based path could create the issue but could
// not inline a real screenshot. Using the session cookie for both avoids two auth systems.
//
// All the privileged work happens in Rust (reqwest, which carries the cookie and is CORS-immune
// and same-origin-credible). This module is the thin core Provider that the editor calls via
// the registry: it shells out to the Rust commands and shapes the result.

import { invoke } from "@tauri-apps/api/core";
import type { Provider, SubmitContext, TFunc } from "@shot2issue/core";

// Workspace is `{ id, kind, name, [key]: string }` in core; github stores owner/repo as string
// fields, so a local structural type keeps this file independent of the core Workspace import
// (which indexes to string and would otherwise need casts everywhere).
interface GhWorkspace {
  owner?: string;
  repo?: string;
  [key: string]: unknown;
}

/** Mirror of the Rust `github::SessionStatus` (serde camelCase). */
interface SessionStatus {
  loggedIn: boolean;
  login: string;
}

/** Open the built-in GitHub-login webview; resolves once a `user_session` cookie is captured. */
export const githubLogin = (): Promise<SessionStatus> => invoke("github_login");

/** Is a github.com `user_session` cookie present + valid? Used for the hint + a pre-submit gate. */
export const githubSessionStatus = (): Promise<SessionStatus> => invoke("github_session_status");

/** Upload one screenshot via the gh-image protocol; returns the user-attachments URL. */
function uploadImage(owner: string, repo: string, dataUrl: string, filename: string): Promise<string> {
  return invoke<string>("github_upload_image", { owner, repo, dataUrl, filename });
}

/** Create the issue on github.com via the session cookie; returns the issue URL. */
function createIssue(owner: string, repo: string, title: string, body: string): Promise<string> {
  return invoke<string>("github_create_issue", { owner, repo, title, body });
}

export const githubProvider: Provider = {
  id: "github",
  label: "GitHub",
  fields: [
    { key: "owner", labelKey: "wsOwner", placeholder: "octocat" },
    { key: "repo", labelKey: "wsRepo", placeholder: "hello-world" },
  ],

  describe(ws): string {
    const w = ws as GhWorkspace;
    return `${w.owner || ""}/${w.repo || ""}`;
  },

  validate(ws): string | null {
    const w = ws as GhWorkspace;
    return !w.owner || !w.repo ? "errWorkspaceNeedsOwnerRepo" : null;
  },

  normalize(ws): Record<string, string> {
    const w = ws as GhWorkspace;
    return { owner: (w.owner || "").trim(), repo: (w.repo || "").trim() };
  },

  permissionOrigins(): string[] {
    return [];
  },

  async hint(_ws, t: TFunc): Promise<{ text: string; ok: boolean }> {
    const { loggedIn, login } = await githubSessionStatus();
    return loggedIn
      ? { text: t("loginSignedInAs", [login]), ok: true }
      : { text: "⚠ " + t("loginNotSignedIn"), ok: false };
  },

  async submit(ws, ctx: SubmitContext) {
    const w = ws as GhWorkspace;
    const owner = (w.owner || "").trim();
    const repo = (w.repo || "").trim();

    ctx.busy("statusCheckingLogin");
    const { loggedIn } = await githubSessionStatus();
    if (!loggedIn) throw new Error(ctx.t("errNotSignedIn"));

    // 1) Upload each screenshot via the gh-image protocol (Rust) and collect the
    //    user-attachments markdown, in order. The session cookie makes these same-origin-credible.
    const md: string[] = [];
    if (ctx.withImage) {
      for (const img of ctx.images) {
        ctx.busy("statusSubmitting");
        const url = await uploadImage(owner, repo, img.dataUrl, img.filename);
        md.push(`![${img.filename}](${url})`);
      }
    }

    // 2) Compose the body with the uploaded images inlined, then create the issue (Rust, same
    //    cookie). Unlike the extension's in-page composer, upload + create are separate HTTP
    //    flows here, but both ride the one web session, so private-repo attachments still render.
    let body = ctx.body || "";
    if (md.length) body = (body ? body.replace(/\s+$/, "") + "\n\n" : "") + md.join("\n\n");

    ctx.busy(ctx.withImage ? "statusSubmitting" : "statusSubmittingNoImage");
    const url = await createIssue(owner, repo, ctx.title, body);
    const m = url.match(/\/issues\/(\d+)/);
    return { url, number: m ? m[1] : "" };
  },
};
