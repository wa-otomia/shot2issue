// MV3 service worker.
//
// The toolbar icon opens a small popup (popup.html) with two capture sources: the current
// tab, or the screen/window (via chrome.desktopCapture). Each source can also be bound to
// its own keyboard shortcut. A capture is staged in session storage and the editor is
// opened; re-capturing while an editor is open APPENDS the new screenshot to it.
//
// Desktop capture needs getUserMedia, which the service worker lacks, so it runs in an
// offscreen document.

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

// ---- capture: screen / window (desktopCapture + offscreen) ------------------
function chooseDesktopMedia(): Promise<string> {
  // Screen + window only. Do NOT pass a targetTab: a tab-bound stream "can only be used by
  // the specified tab", so consuming it in the offscreen document fails with
  // "Error starting tab capture". Omitting targetTab makes the streamId usable anywhere in
  // the extension. (The current tab is already covered by the "Web screenshot" option.)
  return new Promise((resolve, reject) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || 'picker error'));
          return;
        }
        resolve(streamId || ''); // '' means the user cancelled the picker
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

async function ensureOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture a frame of the chosen screen or window for the screenshot.',
    });
  } catch (e) {
    // A document already exists (e.g. a quick second capture) — reuse it.
    if (!String(e).toLowerCase().includes('single offscreen')) throw e;
  }
}

async function grabViaOffscreen(streamId: string): Promise<string> {
  await ensureOffscreen();
  try {
    const res = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'grab-frame', streamId })) as
      | { ok: boolean; dataUrl?: string; error?: string }
      | undefined;
    if (!res) throw new Error('the offscreen capture did not respond');
    if (!res.ok || !res.dataUrl) throw new Error(res.error || 'capture failed');
    return res.dataUrl;
  } finally {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* already closed */
    }
  }
}

async function captureDesktop(tab: chrome.tabs.Tab): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);
  try {
    const streamId = await chooseDesktopMedia();
    if (!streamId) return; // the user cancelled the picker — do nothing, no error
    const dataUrl = await grabViaOffscreen(streamId);
    await stageAndOpen(tab, makeAttachment(dataUrl, tab, 'desktop'));
  } catch (e) {
    notify(t('captureDesktopFailed', [e instanceof Error && e.message ? e.message : String(e)]));
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- triggers --------------------------------------------------------------
// Popup buttons.
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (!msg || (msg.type !== 'capture-web' && msg.type !== 'capture-desktop')) return;
  void (async () => {
    const tab = await activeTab();
    if (!tab) return;
    if (msg.type === 'capture-web') await captureWeb(tab);
    else await captureDesktop(tab);
  })();
});

// Keyboard shortcuts (bound at chrome://extensions/shortcuts), gated by the Settings toggle.
chrome.commands.onCommand.addListener(async (command: string, tab?: chrome.tabs.Tab) => {
  if (command !== 'capture' && command !== 'capture-desktop') return;
  const config = await getConfig();
  if (!config.shortcutEnabled) return;
  const target = tab || (await activeTab());
  if (!target) return;
  if (command === 'capture') await captureWeb(target);
  else await captureDesktop(target);
});

// Closing the editor ends the staging session (frees the image data held in memory).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = await getPendingShots();
  if (pending && pending.editorTabId === tabId) await clearPendingShots();
});
