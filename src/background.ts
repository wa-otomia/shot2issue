// MV3 service worker.
//
// Entry points: clicking the toolbar icon, or an optional keyboard shortcut, captures the
// visible tab immediately. The capture is staged in session storage and the editor page is
// opened. Re-capturing while an editor is already open APPENDS the new screenshot to that
// editor's attachment list (and focuses it) instead of opening a second editor.
//
// Both entry points are user gestures that grant activeTab, which lets the worker call
// captureVisibleTab and read the tab's url/title.

import {
  getConfig,
  setConfig,
  makeAttachmentId,
  getPendingShots,
  setPendingShots,
  patchPendingShots,
  appendPendingShot,
  clearPendingShots,
} from './lib/storage.js';
import { setLanguage, t } from './lib/i18n.js';
import type { Attachment, PendingShots } from './lib/types.js';

chrome.runtime.onInstalled.addListener(async (details) => {
  // Ensure local storage holds a configuration with defaults.
  const config = await getConfig();
  await setConfig(config);
  // On a fresh install, open the options page to guide initial setup.
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

/** True if the given tab id still exists. */
async function tabAlive(id?: number): Promise<boolean> {
  if (id == null) return false;
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

/** Bring a tab (and its window) to the foreground. */
async function focusTab(id: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(id, { active: true });
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab gone */
  }
}

/** Capture the given tab and either append to an open editor or open a new one. */
async function captureAndOpenEditor(tab: chrome.tabs.Tab): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);

  let attachment: Attachment | null = null;
  let captureError: string | undefined;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!dataUrl) throw new Error('no image data');
    attachment = {
      id: makeAttachmentId(),
      dataUrl,
      pageUrl: tab.url || '',
      pageTitle: tab.title || '',
      sourceTabId: tab.id,
      sourceWindowId: tab.windowId,
      sourceId: 'tab',
      ops: [],
      createdAt: Date.now(),
    };
  } catch (e) {
    // Restricted pages (chrome://, the Web Store, etc.) cannot be captured.
    captureError = t('captureFailed', [e instanceof Error && e.message ? e.message : String(e)]);
  }

  const existing = await getPendingShots();
  const editorOpen = !!existing && (await tabAlive(existing.editorTabId));

  // An editor is already open: append the new shot (if any) and focus it; never open a 2nd.
  if (editorOpen && existing) {
    if (attachment) await appendPendingShot(attachment);
    await focusTab(existing.editorTabId as number);
    return;
  }

  // Fresh session: stage the envelope (with the shot, or the capture error) and open the editor.
  const envelope: PendingShots = {
    attachments: attachment ? [attachment] : [],
    type: config.lastType || config.types[0] || '',
    workspaceId: config.lastWorkspaceId || (config.workspaces[0] && config.workspaces[0].id) || '',
    sourceTabId: tab.id,
    sourceWindowId: tab.windowId,
    error: captureError,
  };
  await setPendingShots(envelope);
  const editorTab = await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
  if (editorTab.id != null) await patchPendingShots({ editorTabId: editorTab.id });
}

// Toolbar icon.
chrome.action.onClicked.addListener((tab) => {
  captureAndOpenEditor(tab);
});

// Optional keyboard shortcut. The key is bound at chrome://extensions/shortcuts; this
// handler only acts when the user has enabled the shortcut in Settings (off by default).
chrome.commands.onCommand.addListener(async (command: string, tab?: chrome.tabs.Tab) => {
  if (command !== 'capture') return;
  const config = await getConfig();
  if (!config.shortcutEnabled) return;
  let target = tab;
  if (!target) [target] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (target) captureAndOpenEditor(target);
});

// Closing the editor ends the staging session (frees the image data held in memory).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = await getPendingShots();
  if (pending && pending.editorTabId === tabId) await clearPendingShots();
});
