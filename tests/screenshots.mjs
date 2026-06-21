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
      }),
      chrome.storage.session.set({
        pendingShot: { dataUrl, pageUrl: 'https://app.example.com/dashboard', pageTitle: 'Dashboard', type: 'Bug', workspaceId: 'w1' },
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

  // Rectangle around the "Save" button area.
  await drag(at(0.25, 0.72), at(0.46, 0.86));
  // Arrow pointing at it.
  await editor.click('.tool[data-tool="arrow"]');
  await drag(at(0.68, 0.55), at(0.47, 0.79));
  // Freehand pen underline near the title.
  await editor.click('.tool[data-tool="pen"]');
  await drag(at(0.30, 0.30), at(0.52, 0.31));
  // Text label.
  await editor.click('.tool[data-tool="text"]');
  const tp = at(0.55, 0.45);
  await editor.mouse.click(tp.x, tp.y);
  await editor.waitForSelector('#textInput', { state: 'visible' });
  await editor.focus('#textInput'); // ensure focus before typing (avoid dropping the first char)
  await editor.waitForTimeout(150);
  await editor.keyboard.type('Misaligned');
  await editor.keyboard.press('Control+Enter');

  // A descriptive title.
  await editor.fill('#title', 'Save button is misaligned Bug');
  await editor.waitForTimeout(300);
  await editor.screenshot({ path: resolve(outDir, 'editor.png') });
  console.log('wrote docs/screenshots/editor.png');

  // --- Options: show workspaces (GitHub + YouTrack) ---
  const options = await context.newPage();
  await options.setViewportSize({ width: 1280, height: 980 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForSelector('.ws-card');
  await options.waitForTimeout(300);
  await options.screenshot({ path: resolve(outDir, 'options.png') });
  console.log('wrote docs/screenshots/options.png');
} finally {
  await context.close();
}
