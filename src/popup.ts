// Toolbar popup: choose a capture source (current tab vs screen/window). Each option shows
// its bound keyboard shortcut when one is set. The actual capture runs in the service
// worker; the popup just sends the request and closes.

import { getConfig } from './lib/storage.js';
import { setLanguage, localizeDom } from './lib/i18n.js';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function showShortcut(id: string, shortcut?: string): void {
  const el = $(id);
  if (shortcut) {
    el.textContent = shortcut;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function trigger(type: 'capture-web' | 'capture-desktop'): void {
  void chrome.runtime.sendMessage({ type });
  window.close();
}

async function init(): Promise<void> {
  const config = await getConfig();
  setLanguage(config.lang);
  localizeDom(document);

  // Show the bound shortcut next to each option, if the user has set one.
  try {
    const cmds = await chrome.commands.getAll();
    showShortcut('scWeb', cmds.find((c) => c.name === 'capture')?.shortcut);
    showShortcut('scDesktop', cmds.find((c) => c.name === 'capture-desktop')?.shortcut);
  } catch {
    /* commands API unavailable; show no shortcuts */
  }

  $('optWeb').addEventListener('click', () => trigger('capture-web'));
  $('optDesktop').addEventListener('click', () => trigger('capture-desktop'));
  $('setShortcuts').addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });
}

void init();
