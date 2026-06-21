// Toolbar popup: choose a capture source (current tab vs screen/window). Each option shows
// its bound keyboard shortcut when one is set. The actual capture runs in the service
// worker; the popup just sends the request and closes.

import { getConfig } from './lib/storage.js';
import { setLanguage, localizeDom, t } from './lib/i18n.js';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** Read an image from the clipboard (this click is the user gesture) and hand it to the worker. */
async function pasteFromClipboard(btn: HTMLElement): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((ty) => ty.startsWith('image/'));
      if (type) {
        const dataUrl = await blobToDataUrl(await it.getType(type));
        void chrome.runtime.sendMessage({ type: 'capture-clipboard', dataUrl });
        window.close();
        return;
      }
    }
    btn.textContent = t('pasteNoImage'); // no image on the clipboard — tell the user, keep open
  } catch {
    btn.textContent = t('pasteNoImage');
  }
}

function showShortcut(id: string, shortcut?: string): void {
  const el = $(id);
  if (shortcut) {
    el.textContent = shortcut;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function trigger(type: 'capture-web'): void {
  void chrome.runtime.sendMessage({ type });
  window.close();
}

// Bind clicks SYNCHRONOUSLY so the very first click always works. (Previously these were bound
// after `await getConfig()`, so a click during that async gap hit nothing — hence "click twice".)
$('optWeb').addEventListener('click', () => trigger('capture-web'));
$('optPaste').addEventListener('click', () => void pasteFromClipboard($('optPaste')));
$('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('setShortcuts').addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});
localizeDom(document); // localize immediately (default language); re-localized once config loads

async function init(): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);
  localizeDom(document);
  // Show the bound shortcut next to the tab-capture option, if the user has set one.
  try {
    const cmds = await chrome.commands.getAll();
    showShortcut('scWeb', cmds.find((c) => c.name === 'capture')?.shortcut);
  } catch {
    /* commands API unavailable; show no shortcuts */
  }
}

void init();
