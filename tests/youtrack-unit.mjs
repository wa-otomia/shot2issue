// Unit test for createYouTrackIssue (lib/youtrack.ts) with a mocked fetch.
// Verifies that EVERY screenshot is embedded inline (by its real attachment URL), not just the
// first one. Run after `npm run build`:  node tests/youtrack-unit.mjs

import { createYouTrackIssue } from '../build/lib/youtrack.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

let calls = [];
// Routes: create issue -> upload attachment (returns a unique real url) -> update description.
globalThis.fetch = async (url, opts = {}) => {
  const c = { url: String(url), method: (opts.method || 'GET').toUpperCase(), body: opts.body };
  calls.push(c);
  const u = c.url;
  if (u.includes('/api/issues?fields=id,idReadable')) return jsonResp({ id: '2-5', idReadable: 'PROJ-5' });
  if (u.includes('/attachments?')) {
    const n = calls.filter((x) => x.url.includes('/attachments?')).length;
    return jsonResp({ id: `7-${n}`, name: `shot-${n}.png` });
  }
  if (/\/api\/issues\/[^/?]+\?fields=id$/.test(u)) return jsonResp({ id: '2-5' });
  return jsonResp({ error: 'unexpected route' }, 404);
};

// --- two screenshots: both must end up inline ---
const result = await createYouTrackIssue({
  baseUrl: 'https://example.youtrack.cloud',
  token: 'perm:abc',
  project: '0-1', // internal id form → skips the project lookup
  title: 'Two screenshots',
  body: 'the bug body',
  images: [
    { dataUrl: 'data:image/png;base64,AAAA', filename: 'shot-1.png' },
    { dataUrl: 'data:image/png;base64,BBBB', filename: 'shot-2.png' },
  ],
});

const createCall = calls.find((c) => c.url.includes('/api/issues?fields=id,idReadable'));
const attachCalls = calls.filter((c) => c.url.includes('/attachments?'));
const updateCall = calls.find((c) => /\/api\/issues\/[^/?]+\?fields=id$/.test(c.url));
const createBody = JSON.parse(createCall.body);
const updateBody = updateCall ? JSON.parse(updateCall.body) : {};

check('youtrack: issue created with the text body only (no image markdown yet)',
  createBody.description === 'the bug body' && !createBody.description.includes('!['));
check('youtrack: every image uploaded as an attachment', attachCalls.length === 2);
check('youtrack: description is updated after the uploads', !!updateCall);
check('youtrack: ALL images embedded inline by file name (not just the first)',
  !!updateCall &&
    updateBody.description.includes('![shot-1.png](shot-1.png)') &&
    updateBody.description.includes('![shot-2.png](shot-2.png)'));
check('youtrack: original body preserved above the images', updateBody.description.startsWith('the bug body'));
check('youtrack: the description update happens after issue creation',
  calls.indexOf(createCall) < calls.indexOf(updateCall));
check('youtrack: returns the readable id', result.number === 'PROJ-5' && result.url.includes('/issue/PROJ-5'));

// --- no screenshots: must not upload or update, body stays as-is ---
calls = [];
const noImg = await createYouTrackIssue({
  baseUrl: 'https://example.youtrack.cloud',
  token: 'perm:abc',
  project: '0-1',
  title: 'No screenshot',
  body: 'text only',
  images: [],
});
check('youtrack: no images → no attachment upload', calls.filter((c) => c.url.includes('/attachments?')).length === 0);
check('youtrack: no images → no description update', !calls.some((c) => /\/api\/issues\/[^/?]+\?fields=id$/.test(c.url)));
check('youtrack: no images → body submitted verbatim',
  JSON.parse(calls[0].body).description === 'text only' && noImg.number === 'PROJ-5');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
