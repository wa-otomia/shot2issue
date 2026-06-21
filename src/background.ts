// MV3 service worker.
//
// The toolbar icon opens a small popup (popup.html) with two capture sources: the current
// tab, or an image pasted from the clipboard. The tab capture can also be bound to a keyboard
// shortcut. A capture is staged in chrome.storage.local and the editor is opened; re-capturing
// (or pasting) while an editor is open APPENDS the new screenshot to it.

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
  const config = await getConfig();
  await setConfig(config);
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

// ---- helpers ---------------------------------------------------------------
async function tabAlive(id?: number): Promise<boolean> {
  if (id == null) return false;
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

async function focusTab(id: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(id, { active: true });
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab gone */
  }
}

/** Surface a capture error as a system notification (visible regardless of editor state). */
function notify(message: string): void {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'shot2issue',
      message,
    });
  } catch {
    /* notifications unavailable */
  }
}

function makeAttachment(dataUrl: string, tab: chrome.tabs.Tab, sourceId: string): Attachment {
  return {
    id: makeAttachmentId(),
    dataUrl,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    sourceTabId: tab.id,
    sourceWindowId: tab.windowId,
    sourceId,
    ops: [],
    createdAt: Date.now(),
  };
}

/** Append a captured screenshot to an open editor (and focus it), or open a new editor. */
async function stageAndOpen(tab: chrome.tabs.Tab, attachment: Attachment): Promise<void> {
  const config = await getConfig();
  const existing = await getPendingShots();
  const editorOpen = !!existing && (await tabAlive(existing.editorTabId));

  if (editorOpen && existing) {
    await appendPendingShot(attachment);
    await focusTab(existing.editorTabId as number);
    return;
  }

  const envelope: PendingShots = {
    attachments: [attachment],
    type: config.lastType || config.types[0] || '',
    workspaceId: config.lastWorkspaceId || (config.workspaces[0] && config.workspaces[0].id) || '',
    sourceTabId: tab.id,
    sourceWindowId: tab.windowId,
  };
  await setPendingShots(envelope);
  const editorTab = await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
  if (editorTab.id != null) await patchPendingShots({ editorTabId: editorTab.id });
}

// ---- capture: current tab --------------------------------------------------
async function captureWeb(tab: chrome.tabs.Tab): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!dataUrl) throw new Error('no image data');
    await stageAndOpen(tab, makeAttachment(dataUrl, tab, 'tab'));
  } catch (e) {
    notify(t('captureFailed', [e instanceof Error && e.message ? e.message : String(e)]));
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- paste from clipboard (image read in the popup, staged here) -----------
async function captureClipboard(dataUrl: string): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);
  const tab = await activeTab();
  const att: Attachment = {
    id: makeAttachmentId(),
    dataUrl,
    pageUrl: '', // a pasted image isn't tied to the current page
    pageTitle: t('clipboardImage'),
    sourceTabId: tab?.id,
    sourceWindowId: tab?.windowId,
    sourceId: 'clipboard',
    ops: [],
    createdAt: Date.now(),
  };
  await stageAndOpen(tab || ({} as chrome.tabs.Tab), att);
}

// ---- triggers --------------------------------------------------------------
// Popup buttons.
chrome.runtime.onMessage.addListener((msg: { type?: string; dataUrl?: string }) => {
  if (!msg) return;
  if (msg.type === 'capture-clipboard') {
    if (msg.dataUrl) void captureClipboard(msg.dataUrl);
    return;
  }
  if (msg.type !== 'capture-web') return;
  void (async () => {
    const tab = await activeTab();
    if (tab) await captureWeb(tab);
  })();
});

// Keyboard shortcut (bound at chrome://extensions/shortcuts), gated by the Settings toggle.
chrome.commands.onCommand.addListener(async (command: string, tab?: chrome.tabs.Tab) => {
  if (command !== 'capture') return;
  const config = await getConfig();
  if (!config.shortcutEnabled) return;
  const target = tab || (await activeTab());
  if (target) await captureWeb(target);
});

// Closing the editor ends the staging session (frees the staged image data).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = await getPendingShots();
  if (pending && pending.editorTabId === tabId) await clearPendingShots();
});

// Staged screenshots live in chrome.storage.local (persists across restarts), so sweep any
// left over from a previous session on startup when no editor tab is open to claim them.
chrome.runtime.onStartup.addListener(async () => {
  const pending = await getPendingShots();
  if (!pending) return;
  const alive = pending.editorTabId != null && (await tabAlive(pending.editorTabId));
  if (!alive) await clearPendingShots();
});
