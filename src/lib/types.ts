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
