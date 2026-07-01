// GitHub provider (desktop): files issues via github.com WEB SESSION cookies — no OAuth, no PAT.
// Supports MULTIPLE accounts: each workspace binds a github account (by login), and that account's
// `user_session` cookie (captured by the built-in login webview, stored in src-tauri/github.rs)
// drives BOTH image upload and issue creation.
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
  githubAccountId?: string;
  [key: string]: unknown;
}

/** Mirror of the Rust `github::AccountInfo` (serde camelCase). id == login. */
export interface GithubAccount {
  id: string;
  login: string;
}

/** Open the login webview; resolves with the account that signed in (upserted by login). */
export const githubLogin = (): Promise<GithubAccount> => invoke("github_login");

/** All signed-in GitHub accounts (id + login; no session values). */
export const githubAccounts = (): Promise<GithubAccount[]> => invoke("github_accounts");

/** Sign out one GitHub account by id (== login), removing its stored session. */
export const githubLogout = (id: string): Promise<void> => invoke("github_logout", { id });

/** Upload one screenshot via the gh-image protocol using an account's session; returns the URL. */
function uploadImage(accountId: string, owner: string, repo: string, dataUrl: string, filename: string): Promise<string> {
  return invoke<string>("github_upload_image", { accountId, owner, repo, dataUrl, filename });
}

/** Create the issue via an account's session cookie; returns the issue URL. */
function createIssue(accountId: string, owner: string, repo: string, title: string, body: string): Promise<string> {
  return invoke<string>("github_create_issue", { accountId, owner, repo, title, body });
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

  async hint(ws, t: TFunc): Promise<{ text: string; ok: boolean }> {
    const id = ((ws as GhWorkspace).githubAccountId || "").trim();
    const accounts = await githubAccounts();
    // Bound account by id; only fall back to the sole account when truly unbound (empty id).
    // A non-empty id that matches nothing means the bound account signed out — don't substitute.
    const acct = id ? accounts.find((a) => a.id === id) : accounts.length === 1 ? accounts[0] : undefined;
    if (!acct) {
      return id
        ? { text: "⚠ " + t("errBoundAccountSignedOut"), ok: false }
        : { text: "⚠ " + t("loginNotSignedIn"), ok: false };
    }
    return { text: t("loginSignedInAs", [acct.login]), ok: true };
  },

  async submit(ws, ctx: SubmitContext) {
    const w = ws as GhWorkspace;
    const owner = (w.owner || "").trim();
    const repo = (w.repo || "").trim();

    ctx.busy("statusCheckingLogin");
    // Resolve the workspace's bound GitHub account; only fall back to the sole account when the
    // workspace is truly unbound (empty id). A non-empty id that matches nothing means the bound
    // account signed out — surface that instead of silently filing from the wrong account.
    const id = (w.githubAccountId || "").trim();
    const accounts = await githubAccounts();
    const acct = id ? accounts.find((a) => a.id === id) : accounts.length === 1 ? accounts[0] : undefined;
    if (!acct) throw new Error(ctx.t(id ? "errBoundAccountSignedOut" : "errNotSignedInDesktop"));
    const accountId = acct.id;

    // 1) Upload each screenshot via the gh-image protocol (Rust) and collect the
    //    user-attachments markdown, in order. The account's session makes these credible.
    const md: string[] = [];
    if (ctx.withImage) {
      for (const img of ctx.images) {
        ctx.busy("statusSubmitting");
        const url = await uploadImage(accountId, owner, repo, img.dataUrl, img.filename);
        md.push(`![${img.filename}](${url})`);
      }
    }

    // 2) Compose the body with the uploaded images inlined, then create the issue (Rust, same
    //    account session). upload + create are separate HTTP flows but both ride one web session,
    //    so private-repo attachments still render.
    let body = ctx.body || "";
    if (md.length) body = (body ? body.replace(/\s+$/, "") + "\n\n" : "") + md.join("\n\n");

    ctx.busy(ctx.withImage ? "statusSubmitting" : "statusSubmittingNoImage");
    const url = await createIssue(accountId, owner, repo, ctx.title, body);
    const m = url.match(/\/issues\/(\d+)/);
    return { url, number: m ? m[1] : "" };
  },
};
