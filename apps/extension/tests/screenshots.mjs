// Capture README screenshots by driving the built extension (English UI) under Xvfb.
// Produces docs/screenshots/editor.png and docs/screenshots/options.png.
//
// Run: xvfb-run -a node tests/screenshots.mjs   (after `npm run build`)

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeSampleDataUrlSW } from './sample-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extPath = resolve(root, 'build');
const outDir = resolve(root, 'docs/screenshots');
mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/pw-`), {
  headless: false,
  viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-sandbox'],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = sw.url().split('/')[2];

  const dataUrl = await makeSampleDataUrlSW(sw);
  await sw.evaluate((dataUrl) => {
    return Promise.all([
      chrome.storage.local.set({
        config: {
          workspaces: [
            { id: 'w1', kind: 'github', name: 'Frontend bugs', owner: 'octocat', repo: 'webapp' },
            { id: 'w2', kind: 'youtrack', name: 'Platform', baseUrl: 'https://acme.youtrack.cloud', project: 'PLAT', token: 'perm:demo' },
          ],
          types: ['Change', 'Bug', 'Feature'],
          lang: 'en',
          closeAfterSubmit: true,
          shortcutEnabled: false,
          lastWorkspaceId: 'w1',
          lastType: 'Bug',
        },
        aiAuth: {
          accessToken: 'demo', planType: 'pro', email: 'you@example.com',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'], model: 'gpt-5.5', connectedAt: 1,
        },
      }),
      // Staged screenshots now live in local storage (was session) to avoid the quota limit.
      chrome.storage.local.set({
        pendingShots: {
          attachments: [
            { id: 'a1', dataUrl, pageUrl: 'https://app.example.com/dashboard', pageTitle: 'Dashboard', ops: [], createdAt: 1 },
            { id: 'a2', dataUrl, pageUrl: 'https://app.example.com/settings', pageTitle: 'Settings', ops: [], createdAt: 2 },
          ],
          type: 'Bug',
          workspaceId: 'w1',
        },
      }),
    ]);
  }, dataUrl);

  // --- Editor: draw a few annotations, then screenshot ---
  const editor = await context.newPage();
  await editor.setViewportSize({ width: 1280, height: 860 });
  await editor.goto(`chrome-extension://${extId}/editor.html`);
  await editor.waitForFunction(() => {
    const c = document.getElementById('canvas');
    return c && !c.classList.contains('hidden') && c.width > 0;
  });
  const box = await editor.$eval('#canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const at = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });
  const drag = async (p, q) => {
    await editor.mouse.move(p.x, p.y);
    await editor.mouse.down();
    await editor.mouse.move(q.x, q.y, { steps: 8 });
    await editor.mouse.up();
  };

  // Two numbered boxes (the numbered-box tool auto-numbers 1, 2).
  await editor.click('.tool[data-tool="numrect"]');
  await drag(at(0.25, 0.71), at(0.46, 0.86)); // box 1 around Save
  await drag(at(0.27, 0.39), at(0.66, 0.5)); // box 2 around a content row
  // Arrow pointing at box 1.
  await editor.click('.tool[data-tool="arrow"]');
  await drag(at(0.72, 0.6), at(0.47, 0.79));
  // Freehand pen underline near the title.
  await editor.click('.tool[data-tool="pen"]');
  await drag(at(0.3, 0.3), at(0.5, 0.305));
  // Text label.
  // Text in a dragged region (wraps within the box).
  await editor.click('.tool[data-tool="text"]');
  const tb1 = at(0.52, 0.56), tb2 = at(0.85, 0.67);
  await editor.mouse.move(tb1.x, tb1.y);
  await editor.mouse.down();
  await editor.mouse.move(tb2.x, tb2.y, { steps: 6 });
  await editor.mouse.up();
  await editor.waitForSelector('#textInput', { state: 'visible' });
  await editor.focus('#textInput');
  await editor.waitForTimeout(150);
  await editor.keyboard.type('Button misaligned on small screens');
  await editor.keyboard.press('Control+Enter');

  // A descriptive title.
  await editor.fill('#title', 'Save button is misaligned Bug');
  await editor.waitForTimeout(300);
  await editor.screenshot({ path: resolve(outDir, 'editor.png') });
  console.log('wrote docs/screenshots/editor.png');

  // --- Options: show the Workspaces tab (GitHub + YouTrack) ---
  const options = await context.newPage();
  await options.setViewportSize({ width: 1280, height: 980 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForSelector('#tabBar');
  await options.click('[data-tab="workspaces"]');
  await options.waitForSelector('.ws-card');
  // Workspace cards are collapsed by default; expand them so the screenshot shows the fields.
  for (const tog of await options.$$('.ws-card.collapsed [data-act="toggle"]')) await tog.click();
  await options.waitForTimeout(300);
  await options.screenshot({ path: resolve(outDir, 'options.png') });
  console.log('wrote docs/screenshots/options.png');

  // --- AI assistant settings section (connected view) ---
  await options.click('[data-tab="ai"]'); // the AI panel must be visible to crop it
  const aiHead = options.locator('h2[data-i18n="aiHeading"]');
  await aiHead.scrollIntoViewIfNeeded();
  await options.waitForTimeout(200);
  const hb = await aiHead.boundingBox();
  const cb = await options.locator('#aiConnectedBox').boundingBox();
  if (hb && cb) {
    await options.screenshot({
      path: resolve(outDir, 'ai.png'),
      clip: { x: cb.x - 8, y: hb.y - 8, width: cb.width + 16, height: cb.y + cb.height - hb.y + 16 },
    });
    console.log('wrote docs/screenshots/ai.png');
  }

  // --- Popup: the two capture sources, with sample shortcuts shown ---
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 280, height: 200 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForSelector('#optWeb');
  // Inject sample shortcuts so the doc shows what bound shortcuts look like.
  await pop.evaluate(() => {
    const set = (id, text) => {
      const el = document.getElementById(id);
      el.textContent = text;
      el.hidden = false;
    };
    set('scWeb', 'Ctrl+Shift+S');
  });
  await pop.waitForTimeout(150);
  const body = await pop.$('body');
  if (body) {
    await body.screenshot({ path: resolve(outDir, 'popup.png') });
    console.log('wrote docs/screenshots/popup.png');
  }
} finally {
  await context.close();
}
