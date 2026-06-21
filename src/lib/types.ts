// Shared data types.

/** A configured issue target. All fields are strings; backend-specific fields vary by kind. */
export interface Workspace {
  id: string;
  /** Provider id ('github', 'youtrack', …); a missing value is treated as 'github'. */
  kind: string;
  name: string;
  /** Backend-specific fields (owner/repo, or baseUrl/project/token). */
  [key: string]: string;
}

/** Persisted configuration (chrome.storage.local). */
export interface Config {
  workspaces: Workspace[];
  types: string[];
  lang: string;
  /** Default issue title template; placeholders {pageTitle}, {pageUrl}, {type}. */
  titleTemplate: string;
  /** Default issue body template; same placeholders. */
  bodyTemplate: string;
  closeAfterSubmit: boolean;
  shortcutEnabled: boolean;
  lastWorkspaceId: string;
  lastType: string;
}

/** The screenshot staged for editing (chrome.storage.session). `error` is set if capture failed. */
export interface PendingShot {
  dataUrl?: string;
  pageUrl?: string;
  pageTitle?: string;
  type?: string;
  workspaceId?: string;
  sourceTabId?: number;
  sourceWindowId?: number;
  error?: string;
}

/** Result of creating an issue. */
export interface IssueResult {
  url: string;
  number: string;
}

/**
 * Stored credentials and metadata for the optional AI assistant (OpenAI Codex /
 * ChatGPT-subscription OAuth). Kept in chrome.storage.local under its own key, separate
 * from Config, so configuration backups never include these secrets.
 */
export interface AiAuth {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** ChatGPT account id (from the id_token); sent as the ChatGPT-Account-Id header. */
  accountId?: string;
  /** Subscription tier, e.g. 'plus' | 'pro' | 'free' (from the id_token). */
  planType?: string;
  email?: string;
  /** Access-token expiry (epoch ms), used to refresh proactively. */
  expiresAt?: number;
  /** Models the user may call; populated best-effort, falls back to a default list. */
  models?: string[];
  /** Model chosen for title generation. */
  model?: string;
  /** Last seen usage/quota, captured from x-codex-* response headers. */
  quota?: AiQuota;
  connectedAt: number;
}

/** Best-effort usage snapshot parsed from the backend's x-codex-* response headers. */
export interface AiQuota {
  /** Raw x-codex-* headers, for display and forward-compatibility. */
  raw: Record<string, string>;
  /** Convenience: percent used in the rolling 5-hour window, if present. */
  primaryUsedPercent?: number;
  /** Convenience: percent used in the weekly window, if present. */
  secondaryUsedPercent?: number;
  checkedAt: number;
}

/** PKCE + state held between starting an OAuth flow and completing it (session storage). */
export interface AiPendingAuth {
  verifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}
