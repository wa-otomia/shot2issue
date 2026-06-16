// MV3 service worker.
//
// Entry point: clicking the toolbar icon captures the visible tab immediately.
// The manifest declares no default_popup, so action clicks fire onClicked. The
// capture is staged in session storage and the editor page is opened, where the
// workspace/type selection, annotation, and submission take place.
//
// Capturing here works because clicking the icon grants activeTab, which lets the
// worker call captureVisibleTab and read the tab's url/title.

import { getConfig, setConfig, setPendingShot } from './lib/storage.js';
import { setLanguage, t } from './lib/i18n.js';

chrome.runtime.onInstalled.addListener(async (details) => {
  // Ensure local storage holds a configuration with defaults.
  const config = await getConfig();
  await setConfig(config);
  // On a fresh install, open the options page to guide initial setup.
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const config = await getConfig();
  setLanguage(config.lang);
  try {
    // Capture the visible area of the current window (activeTab was just granted).
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!dataUrl) throw new Error('no image data');

    // Default to the last-used workspace/type; the user can change them in the editor.
    // Record the source tab so the editor can return to it after a successful submit.
    await setPendingShot({
      dataUrl,
      pageUrl: tab.url || '',
      pageTitle: tab.title || '',
      type: config.lastType || config.types[0] || '',
      workspaceId: config.lastWorkspaceId || (config.workspaces[0] && config.workspaces[0].id) || '',
      sourceTabId: tab.id,
      sourceWindowId: tab.windowId,
    });
  } catch (e) {
    // Restricted pages (chrome://, the Web Store, etc.) cannot be captured. Stage an
    // error so the editor can explain why, instead of failing silently.
    await setPendingShot({ error: t('captureFailed', [e && e.message ? e.message : String(e)]) });
  }
  // Open the editor either way (it shows the error when capture failed).
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});
