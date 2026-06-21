// Playwright smoke test for the built extension (build/).
//
// Verifies the in-extension surfaces most at risk from the TypeScript migration:
// the extension loads, the options page switches provider fields and language, and the
// editor renders a staged screenshot and closes on Esc. It does NOT test live submission
// to GitHub/YouTrack (that needs real accounts/sessions).
//
// Run: xvfb-run -a node tests/smoke.mjs   (from the repo root, after `npm run build`)

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeSampleDataUrlSW } from './sample-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extPath = resolve(root, 'build');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/pw-`), {
  headless: false,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-sandbox'],
});

const pageErrors = [];
context.on('weberror', (e) => pageErrors.push(String(e.error())));

try {
  // --- Extension loads: get its id from the service worker ---
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = sw.url().split('/')[2];
  check('extension service worker registered', !!extId);

  // Generate a realistic sample screenshot in the service worker (OffscreenCanvas).
  const dataUrl = await makeSampleDataUrlSW(sw);

  // Seed config (a GitHub + a YouTrack workspace) and the pending screenshot.
  await sw.evaluate((dataUrl) => {
    return Promise.all([
      chrome.storage.local.set({
        config: {
          workspaces: [
            { id: 'w1', kind: 'github', name: 'Demo', owner: 'octocat', repo: 'hello-world' },
            { id: 'w2', kind: 'youtrack', name: 'YT Demo', baseUrl: 'https://example.youtrack.cloud', project: 'DEMO', token: 'perm:xxx' },
          ],
          types: ['Change', 'Bug', 'Feature'],
          lang: 'en',
          closeAfterSubmit: false,
          shortcutEnabled: false,
          lastWorkspaceId: 'w1',
          lastType: 'Bug',
        },
      }),
      chrome.storage.session.set({
        pendingShot: { dataUrl, pageUrl: 'https://example.com/x', pageTitle: 'Example', type: 'Bug', workspaceId: 'w1' },
      }),
    ]);
  }, dataUrl);

  // --- Options page: provider field switching + i18n ---
  const options = await context.newPage();
  options.on('pageerror', (e) => pageErrors.push(String(e)));
  await options.goto(`chrome-extension://${extId}/options.html`);
  // One workspace is seeded, so operate on the LAST card (the one we add here).
  await options.click('#addWorkspace');
  const card = '.ws-card:last-of-type';
  await options.waitForSelector(`${card} [data-k="owner"]`);
  check('options: GitHub workspace shows owner/repo fields',
    (await options.$(`${card} [data-k="owner"]`)) && (await options.$(`${card} [data-k="repo"]`)));

  await options.selectOption(`${card} [data-k="kind"]`, 'youtrack');
  await options.waitForSelector(`${card} [data-k="baseUrl"]`);
  check('options: switching to YouTrack shows baseUrl/project/token',
    (await options.$(`${card} [data-k="baseUrl"]`)) &&
      (await options.$(`${card} [data-k="project"]`)) &&
      (await options.$(`${card} [data-k="token"]`)));
  check('options: GitHub fields removed after switch', !(await options.$(`${card} [data-k="owner"]`)));

  // i18n: switch to Chinese, a known heading should localize.
  await options.selectOption('#lang', 'zh');
  await options.waitForFunction(() =>
    (document.querySelector('[data-i18n="workspacesHeading"]')?.textContent || '').includes('工作空间'));
  check('options: language switch localizes headings to Chinese', true);

  // --- Editor page: renders staged screenshot, Esc closes the tab ---
  const editor = await context.newPage();
  editor.on('pageerror', (e) => pageErrors.push(String(e)));
  await editor.goto(`chrome-extension://${extId}/editor.html`);
  await editor.waitForFunction(() => {
    const c = document.getElementById('canvas');
    return c && !c.classList.contains('hidden') && c.width > 0;
  }, { timeout: 8000 });
  check('editor: staged screenshot rendered on canvas', true);
  check('editor: workspace + type selectors populated',
    (await editor.$eval('#workspace', (el) => el.options.length)) >= 1 &&
      (await editor.$eval('#type', (el) => el.options.length)) >= 3);

  // Workspace options are tagged with the backend, e.g. "Demo (GitHub)" / "YT Demo (YouTrack)".
  const wsLabels = await editor.$$eval('#workspace option', (opts) => opts.map((o) => o.textContent || ''));
  check('editor: workspace options tagged with backend',
    wsLabels.some((s) => /\(GitHub\)/.test(s)) && wsLabels.some((s) => /\(YouTrack\)/.test(s)));

  // Geometry of the (scaled-to-fit) canvas; click using fractions so points land on it.
  const box = await editor.$eval('#canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const at = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });

  // Rectangle, then Ctrl+Z (must not throw).
  let p1 = at(0.1, 0.2), p2 = at(0.4, 0.5);
  await editor.mouse.move(p1.x, p1.y);
  await editor.mouse.down();
  await editor.mouse.move(p2.x, p2.y, { steps: 5 });
  await editor.mouse.up();
  await editor.keyboard.press('Control+z');
  check('editor: annotate + Ctrl+Z ran without errors', true);

  // Pen (freehand) tool.
  await editor.click('.tool[data-tool="pen"]');
  const a = at(0.15, 0.6), b = at(0.3, 0.75), c2 = at(0.45, 0.62);
  await editor.mouse.move(a.x, a.y);
  await editor.mouse.down();
  await editor.mouse.move(b.x, b.y, { steps: 4 });
  await editor.mouse.move(c2.x, c2.y, { steps: 4 });
  await editor.mouse.up();
  check('editor: pen tool drew without errors', true);

  // Text tool: a transparent textarea sized to the current thickness appears.
  await editor.click('.tool[data-tool="text"]');
  const tp = at(0.55, 0.3);
  await editor.mouse.click(tp.x, tp.y);
  await editor.waitForSelector('#textInput', { state: 'visible' });
  const ti = await editor.$eval('#textInput', (el) => {
    const cs = getComputedStyle(el);
    return { tag: el.tagName, bg: cs.backgroundColor, fontSize: parseFloat(cs.fontSize) };
  });
  check('editor: text input is a transparent textarea',
    ti.tag === 'TEXTAREA' && (ti.bg === 'rgba(0, 0, 0, 0)' || ti.bg === 'transparent'));
  check('editor: text input font size tracks thickness (>14px)', ti.fontSize > 14);
  await editor.keyboard.type('Bug here');
  await editor.keyboard.press('Control+Enter');
  check('editor: text commit ran without errors', true);

  // Esc closes the editor tab. Move focus off the text input first (a non-text tool button).
  await editor.click('.tool[data-tool="rect"]');
  const closed = editor.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false);
  // The keypress may reject if the page closes mid-call — that itself means Esc worked.
  await editor.keyboard.press('Escape').catch(() => {});
  check('editor: Esc closes the tab', await closed);

  check('no uncaught page errors during flows', pageErrors.length === 0);
  if (pageErrors.length) console.log('  page errors:\n' + pageErrors.map((e) => '    ' + e).join('\n'));
} catch (e) {
  failed++;
  console.log('  FAIL  unexpected error: ' + (e && e.message ? e.message : e));
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
