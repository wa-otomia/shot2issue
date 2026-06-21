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
  // Allow clipboard writes for the Copy PNG check below.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {});

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
          titleTemplate: '[{type}] {pageTitle}',
          bodyTemplate: 'URL: {pageUrl}',
          closeAfterSubmit: false,
          shortcutEnabled: false,
          lastWorkspaceId: 'w1',
          lastType: 'Bug',
        },
      }),
      // Staged screenshots now live in local storage (was session) to avoid the quota limit.
      chrome.storage.local.set({
        pendingShots: {
          attachments: [
            { id: 'a1', dataUrl, pageUrl: 'https://example.com/x', pageTitle: 'Example', ops: [], createdAt: 1 },
            { id: 'a2', dataUrl, pageUrl: 'https://example.com/y', pageTitle: 'Example 2', ops: [], createdAt: 2 },
          ],
          type: 'Bug',
          workspaceId: 'w1',
        },
      }),
    ]);
  }, dataUrl);

  // --- Options page: tabs, accounts (incl. migration), provider switching, i18n ---
  const options = await context.newPage();
  options.on('pageerror', (e) => pageErrors.push(String(e)));
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForSelector('#tabBar');

  // Accounts tab: the seeded inline-YouTrack workspace was migrated to an Account.
  await options.click('[data-tab="accounts"]');
  await options.waitForSelector('.acct-card');
  // Account cards are collapsed by default; expand them to read/edit the credential fields.
  check('options: account cards collapsed by default',
    (await options.$$eval('.acct-card.collapsed', (els) => els.length)) >= 1);
  for (const tog of await options.$$('.acct-card.collapsed [data-act="toggle"]')) await tog.click();
  await options.waitForSelector('.acct-card [data-k="baseUrl"]');
  check('options: legacy YouTrack workspace migrated to an account',
    (await options.$eval('.acct-card [data-k="baseUrl"]', (el) => el.value)) === 'https://example.youtrack.cloud' &&
      (await options.$eval('.acct-card [data-k="token"]', (el) => el.value)) === 'perm:xxx');
  await options.click('#addAccount');
  check('options: accounts hold the credential fields (baseUrl + token)',
    (await options.$$eval('.acct-card [data-k="baseUrl"]', (els) => els.length)) >= 2 &&
      (await options.$$eval('.acct-card [data-k="token"]', (els) => els.length)) >= 2);
  check('options: account delete lives in the expandable body',
    (await options.$('.acct-card .acct-body [data-act="remove"]')) !== null);

  // Workspaces tab: GitHub card (owner/repo); account-based card shows account + project.
  await options.click('[data-tab="workspaces"]');
  await options.click('#addWorkspace');
  const card = '.ws-card:last-of-type';
  await options.waitForSelector(`${card} [data-k="owner"]`);
  check('options: GitHub workspace shows owner/repo fields',
    (await options.$(`${card} [data-k="owner"]`)) && (await options.$(`${card} [data-k="repo"]`)));

  await options.selectOption(`${card} [data-k="kind"]`, 'youtrack');
  await options.waitForSelector(`${card} [data-k="accountId"]`);
  check('options: account-based workspace shows account + project, no inline token',
    (await options.$(`${card} [data-k="accountId"]`)) &&
      (await options.$(`${card} [data-k="project"]`)) &&
      !(await options.$(`${card} [data-k="token"]`)) &&
      !(await options.$(`${card} [data-k="baseUrl"]`)));
  check('options: GitHub fields removed after switch', !(await options.$(`${card} [data-k="owner"]`)));
  const targets = await options.$$eval(`${card} [data-k="kind"] option`, (opts) => opts.map((o) => o.value));
  check('options: GitLab is available as a workspace target', targets.includes('gitlab'));

  // Collapsible cards: a freshly added workspace is expanded; toggling collapses it.
  check('options: new workspace card starts expanded',
    !(await options.$eval(card, (el) => el.classList.contains('collapsed'))));
  await options.click(`${card} [data-act="toggle"]`);
  check('options: workspace card collapses on toggle',
    await options.$eval(card, (el) => el.classList.contains('collapsed')));
  await options.click(`${card} [data-act="toggle"]`); // re-expand

  // Delete lives inside the expanded body and needs a second click to confirm.
  check('options: workspace delete is inside the body (not the header)',
    (await options.$(`${card} .ws-body [data-act="remove"]`)) !== null &&
      (await options.$(`${card} .ws-head [data-act="remove"]`)) === null);
  const wsCountBefore = await options.$$eval('.ws-card', (els) => els.length);
  await options.click(`${card} [data-act="remove"]`); // first click only arms it
  check('options: first delete click arms, does not remove',
    (await options.$$eval('.ws-card', (els) => els.length)) === wsCountBefore &&
      (await options.$eval(`${card} [data-act="remove"]`, (el) => el.classList.contains('armed'))) === true);

  // Language tab: its own tab, switching the language localizes the UI.
  check('options: Language has its own tab', (await options.$('[data-tab="language"]')) !== null);
  await options.click('[data-tab="language"]');
  await options.selectOption('#lang', 'zh');
  await options.waitForFunction(() =>
    (document.querySelector('[data-i18n="workspacesHeading"]')?.textContent || '').includes('工作空间'));
  check('options: language switch localizes headings to Chinese', true);

  // General tab: templates.
  await options.click('[data-tab="general"]');
  check('options: title/body template fields reflect config',
    (await options.$eval('#titleTemplate', (el) => el.value)) === '[{type}] {pageTitle}' &&
      (await options.$eval('#bodyTemplate', (el) => el.value)) === 'URL: {pageUrl}');

  // AI tab.
  await options.click('[data-tab="ai"]');
  check('options: AI shows disconnected view by default',
    (await options.$eval('#aiConnectedBox', (el) => el.classList.contains('hidden'))) === true &&
      (await options.$eval('#aiConnect', (el) => el.offsetParent !== null)) === true);

  // Title prompt: prefilled with the (localized) default; Restore refills it.
  const promptDefault = await options.$eval('#aiTitlePrompt', (el) => el.value);
  check('options: AI title prompt prefilled with a default', promptDefault.trim().length > 20);
  await options.fill('#aiTitlePrompt', 'my custom prompt');
  await options.click('#aiPromptRestore');
  check('options: Restore default prompt refills the prompt',
    (await options.$eval('#aiTitlePrompt', (el) => el.value)) === promptDefault &&
      promptDefault !== 'my custom prompt');
  // The complaint prompt is independently configurable with its own default + restore.
  const complaintDefault = await options.$eval('#aiComplaintPrompt', (el) => el.value);
  check('options: complaint prompt prefilled with its own default',
    complaintDefault.trim().length > 20 && complaintDefault !== promptDefault);
  await options.fill('#aiComplaintPrompt', 'custom complaint');
  await options.click('#aiComplaintRestore');
  check('options: Restore refills the complaint prompt',
    (await options.$eval('#aiComplaintPrompt', (el) => el.value)) === complaintDefault);

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

  // The title/body fields are prefilled from the configured templates.
  check('editor: title prefilled from template',
    (await editor.$eval('#title', (el) => el.value)) === '[Bug] Example');
  check('editor: body prefilled from template',
    (await editor.$eval('#body', (el) => el.value)) === 'URL: https://example.com/x');

  // Multi-attachment: the thumbnail strip shows both staged screenshots.
  check('editor: thumbnail strip shows both attachments',
    (await editor.$$eval('#thumbStrip .thumb', (els) => els.length)) === 2);
  // Switching to the 2nd attachment and back keeps the canvas active (attachment 1 active).
  await editor.click('#thumbStrip .thumb:nth-of-type(2)');
  await editor.waitForTimeout(150);
  await editor.click('#thumbStrip .thumb:nth-of-type(1)');
  await editor.waitForTimeout(150);
  check('editor: attachment 1 active after switching back',
    (await editor.$eval('#thumbStrip .thumb:nth-of-type(1)', (el) => el.classList.contains('active'))) === true);

  // The AI-title button is disabled AND visually greyed until the assistant is connected.
  const aiBtnState = await editor.$eval('#aiTitle', (el) => ({
    disabled: el.disabled,
    opacity: parseFloat(getComputedStyle(el).opacity),
  }));
  check('editor: AI title button disabled + greyed when not connected',
    aiBtnState.disabled === true && aiBtnState.opacity < 1);
  check('editor: Complaint button disabled when not connected',
    (await editor.$eval('#complaint', (el) => el.disabled)) === true);

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

  // Numbered-box tool: draw two; the badges auto-number 1, 2.
  await editor.click('.tool[data-tool="numrect"]');
  await editor.mouse.move(at(0.55, 0.6).x, at(0.55, 0.6).y);
  await editor.mouse.down();
  await editor.mouse.move(at(0.75, 0.72).x, at(0.75, 0.72).y, { steps: 5 });
  await editor.mouse.up();
  await editor.mouse.move(at(0.6, 0.15).x, at(0.6, 0.15).y);
  await editor.mouse.down();
  await editor.mouse.move(at(0.85, 0.25).x, at(0.85, 0.25).y, { steps: 5 });
  await editor.mouse.up();
  check('editor: numbered-box tool drew without errors', true);

  // Pen (freehand) tool.
  await editor.click('.tool[data-tool="pen"]');
  const a = at(0.15, 0.6), b = at(0.3, 0.75), c2 = at(0.45, 0.62);
  await editor.mouse.move(a.x, a.y);
  await editor.mouse.down();
  await editor.mouse.move(b.x, b.y, { steps: 4 });
  await editor.mouse.move(c2.x, c2.y, { steps: 4 });
  await editor.mouse.up();
  check('editor: pen tool drew without errors', true);

  // Text tool: DRAG a region; a resizable transparent textarea fills it.
  await editor.click('.tool[data-tool="text"]');
  const t1 = at(0.5, 0.3), t2 = at(0.78, 0.42);
  await editor.mouse.move(t1.x, t1.y);
  await editor.mouse.down();
  await editor.mouse.move(t2.x, t2.y, { steps: 6 });
  await editor.mouse.up();
  await editor.waitForSelector('#textInput', { state: 'visible' });
  const ti = await editor.$eval('#textInput', (el) => {
    const cs = getComputedStyle(el);
    return { tag: el.tagName, bg: cs.backgroundColor, fontSize: parseFloat(cs.fontSize), resize: cs.resize, width: el.offsetWidth };
  });
  check('editor: text input is a transparent textarea',
    ti.tag === 'TEXTAREA' && (ti.bg === 'rgba(0, 0, 0, 0)' || ti.bg === 'transparent'));
  check('editor: text input font size tracks thickness (>14px)', ti.fontSize > 14);
  check('editor: text region is resizable and sized to the drag', ti.resize === 'both' && ti.width > 120);
  await editor.keyboard.type('First note');

  // Clicking a new spot must COMMIT the current text (not lose it) and open a new box.
  await editor.mouse.click(at(0.3, 0.62).x, at(0.3, 0.62).y);
  await editor.waitForTimeout(100);
  await editor.keyboard.type('Second');
  await editor.keyboard.press('Control+Enter');
  check('editor: clicking elsewhere commits text without errors', true);

  // Copy PNG to the clipboard (clipboard permission granted above).
  await editor.bringToFront();
  await editor.click('#copy');
  await editor.waitForSelector('.toast.show', { timeout: 3000 }).catch(() => {});
  const copyToast = await editor.$eval('.toast', (el) => el.textContent || '').catch(() => '');
  check('editor: Copy PNG copies to clipboard', copyToast === 'Copied to clipboard');
  check('editor: has a Paste button for clipboard images', !!(await editor.$('#paste')));

  // Delete the 2nd attachment via its thumbnail's remove button → one remains.
  await editor.click('#thumbStrip .thumb:nth-of-type(2) .thumb-del');
  await editor.waitForTimeout(150);
  check('editor: deleting an attachment leaves one thumbnail',
    (await editor.$$eval('#thumbStrip .thumb', (els) => els.length)) === 1);

  // Esc requires two presses. Move focus off the text input first (a non-text tool button).
  await editor.click('.tool[data-tool="rect"]');
  await editor.keyboard.press('Escape');
  await editor.waitForSelector('.toast.show', { timeout: 2000 }).catch(() => {});
  const toastShown = await editor.$eval('.toast', (el) => el.classList.contains('show')).catch(() => false);
  check('editor: first Esc shows a toast and does not close', toastShown && !editor.isClosed());

  const closed = editor.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false);
  // The second keypress may reject if the page closes mid-call — that itself means it worked.
  await editor.keyboard.press('Escape').catch(() => {});
  check('editor: second Esc closes the tab', await closed);

  // --- AI assistant connected view (seed credentials, then re-open both pages) ---
  await sw.evaluate(() => {
    return chrome.storage.local.set({
      aiAuth: {
        accessToken: 'tok', refreshToken: 'r', idToken: 'i',
        accountId: 'acc_test', planType: 'pro', email: 'dev@example.com',
        // Intentionally the BROKEN state (dashed consumer slugs) to verify self-heal.
        models: ['gpt-5-5', 'gpt-5-5-mini'], model: 'gpt-5-5', connectedAt: 1,
      },
    });
  });

  const options2 = await context.newPage();
  options2.on('pageerror', (e) => pageErrors.push(String(e)));
  await options2.goto(`chrome-extension://${extId}/options.html`);
  await options2.waitForSelector('#tabBar');
  await options2.click('[data-tab="ai"]'); // AI controls live in the AI panel
  await options2.waitForFunction(() => {
    const box = document.getElementById('aiConnectedBox');
    return box && !box.classList.contains('hidden');
  }, { timeout: 8000 });
  check('options: AI connected view shows account + plan',
    (await options2.$eval('#aiAccount', (el) => el.textContent)) === 'dev@example.com' &&
      (await options2.$eval('#aiPlan', (el) => el.textContent)) === 'pro');
  const aiModels = await options2.$$eval('#aiModel option', (opts) => opts.map((o) => o.value));
  check('options: AI model list self-heals to valid Codex slugs',
    aiModels.includes('gpt-5.5') && aiModels.includes('gpt-5.4') && !aiModels.includes('gpt-5-5'));
  check('options: AI selected model healed to default',
    (await options2.$eval('#aiModel', (el) => el.value)) === 'gpt-5.5');

  // Refresh must make a REAL network request to the codex/models endpoint (not a no-op).
  let modelsHit = false;
  await options2.route('**/backend-api/codex/models*', async (route) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    modelsHit = true;
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [{ slug: 'gpt-6.0', priority: 0, visibility: 'list' }, { slug: 'gpt-5.5', priority: 1, visibility: 'list' }] }),
    });
  });
  await options2.click('#aiRefresh');
  await options2.waitForTimeout(900);
  check('options: Refresh fires a real models request (button is not fake)', modelsHit === true);
  const refreshedModels = await options2.$$eval('#aiModel option', (opts) => opts.map((o) => o.value));
  check('options: Refresh updates the dropdown from the fetched list', refreshedModels.includes('gpt-6.0'));

  const editor2 = await context.newPage();
  editor2.on('pageerror', (e) => pageErrors.push(String(e)));
  await editor2.goto(`chrome-extension://${extId}/editor.html`);
  await editor2.waitForFunction(() => {
    const b = document.getElementById('aiTitle');
    return b && !b.disabled;
  }, { timeout: 8000 }).catch(() => {});
  check('editor: AI title button enabled when connected',
    (await editor2.$eval('#aiTitle', (el) => el.disabled)) === false);
  check('editor: Complaint button enabled when connected',
    (await editor2.$eval('#complaint', (el) => el.disabled)) === false);
  check('editor: model picker shown + populated when connected',
    (await editor2.$eval('#aiModel', (el) => !el.classList.contains('hidden'))) === true &&
      (await editor2.$$eval('#aiModel option', (opts) => opts.length)) >= 1);

  // Complaint opens a modal with a text box + record + generate; content persists on reopen.
  await editor2.click('#complaint');
  await editor2.waitForSelector('#complaintModal:not(.hidden)', { timeout: 3000 });
  check('editor: complaint modal has text box, record, generate',
    !!(await editor2.$('#complaintText')) && !!(await editor2.$('#complaintRecord')) && !!(await editor2.$('#complaintGenerate')));
  await editor2.fill('#complaintText', 'box 1 is broken');
  await editor2.click('#complaintClose');
  await editor2.waitForFunction(() => document.getElementById('complaintModal').classList.contains('hidden'), { timeout: 2000 });
  await editor2.click('#complaint');
  await editor2.waitForSelector('#complaintModal:not(.hidden)', { timeout: 3000 });
  check('editor: complaint modal keeps its content on reopen',
    (await editor2.$eval('#complaintText', (el) => el.value)) === 'box 1 is broken');
  // Clear button empties the box.
  await editor2.click('#complaintClear');
  check('editor: complaint Clear empties the text box',
    (await editor2.$eval('#complaintText', (el) => el.value)) === '');
  await editor2.click('#complaintClose');

  // --- Popup: two capture sources; shortcut chips hidden until bound ---
  const popup = await context.newPage();
  popup.on('pageerror', (e) => pageErrors.push(String(e)));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#optWeb');
  check('popup: shows web + desktop + clipboard capture options',
    !!(await popup.$('#optWeb')) && !!(await popup.$('#optDesktop')) && !!(await popup.$('#optPaste')));
  check('popup: option labels are localized',
    (await popup.$eval('#optWeb', (el) => (el.textContent || '').trim())).length > 0);
  check('popup: shortcut chip hidden when none is bound',
    (await popup.$eval('#scWeb', (el) => el.hidden)) === true);
  await popup.close();

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
