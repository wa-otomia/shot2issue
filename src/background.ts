// MV3 service worker.
//
// The toolbar icon opens a small popup (popup.html) with two capture sources: the current
// tab, or the screen/window (via chrome.desktopCapture). Each source can also be bound to
// its own keyboard shortcut. A capture is staged in session storage and the editor is
// opened; re-capturing while an editor is open APPENDS the new screenshot to it.
//
// Desktop capture needs getUserMedia, which the service worker lacks; the chosen desktop
// stream is also bound to its target tab, so we grab a frame by injecting getUserMedia into
// that tab (chrome.scripting) rather than using an offscreen document.

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

// ---- capture: screen / window (desktopCapture, consumed in the target tab) --
//
// From a service worker, chooseDesktopMedia REQUIRES a targetTab, and the resulting stream
// "can only be used by the specified tab" — it is NOT usable in an offscreen document. So we
// pass the active tab and consume the stream by injecting getUserMedia into that same tab.
function chooseDesktopMedia(tab: chrome.tabs.Tab): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], tab, (streamId) => {
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

/**
 * Injected into the target tab: open the chosen desktop stream, grab one frame to a PNG
 * data URL, and stop the tracks. Self-contained (no imports); runs in the tab the stream is
 * bound to, which is the only context allowed to use it.
 */
function grabDesktopFrame(streamId: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  return (async () => {
    try {
      const constraints = {
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
      } as unknown as MediaStreamConstraints;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      try {
        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        for (let i = 0; i < 30 && (!video.videoWidth || !video.videoHeight); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return { ok: true, dataUrl: canvas.toDataURL('image/png') };
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();
}

async function captureDesktop(tab: chrome.tabs.Tab): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);
  if (tab.id == null) {
    notify(t('captureDesktopFailed', ['no active tab']));
    return;
  }
  // The chosen stream is bound to its target tab, so we grab the frame by injecting into that
  // tab — which Chrome forbids on privileged pages. Fail fast (before the picker) with a clear
  // message instead of letting executeScript reject after the user has already picked a source.
  const url = tab.url || '';
  const injectable = /^https?:\/\//.test(url) && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url);
  if (!injectable) {
    notify(t('captureNeedNormalPage'));
    return;
  }
  let streamId: string;
  try {
    streamId = await chooseDesktopMedia(tab);
  } catch (e) {
    notify(t('captureDesktopFailed', [e instanceof Error && e.message ? e.message : String(e)]));
    return;
  }
  if (!streamId) return; // the user cancelled the picker — no error
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabDesktopFrame,
      args: [streamId],
    });
    const res = inj?.result as { ok: boolean; dataUrl?: string; error?: string } | undefined;
    if (!res || !res.ok || !res.dataUrl) throw new Error(res?.error || 'capture failed');
    await stageAndOpen(tab, makeAttachment(res.dataUrl, tab, 'desktop'));
  } catch (e) {
    notify(t('captureDesktopFailed', [e instanceof Error && e.message ? e.message : String(e)]));
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
  if (msg.type !== 'capture-web' && msg.type !== 'capture-desktop') return;
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
