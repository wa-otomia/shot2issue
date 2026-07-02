// Unit tests for the issue providers (gitlab.ts, youtrack.ts) in @shot2issue/core.
//
// These providers import `fetch` from ../net.js (an injected transport seam — see net.ts:
// `bindHttp(fn)` sets the implementation the ported clients call instead of the DOM/global
// fetch). So the network is mocked by binding a stub through that seam via bindHttp(), which
// is the actual mockable boundary the product code reads from. We additionally point
// globalThis.fetch at the very same stub so that nothing in this suite could ever reach the
// real network even if some code path used the global directly.
//
// Run after the core has been built (build/ already holds compiled JS matching src/):
//   node tests/providers-unit.mjs

import { bindHttp } from '../build/net.js';
import { createGitLabIssue, encodeProjectId } from '../build/providers/gitlab.js';
import { createYouTrackIssue } from '../build/providers/youtrack.js';

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

// A "known bug" check still runs and is reported, but doesn't flip the process exit code —
// it documents a real defect in product code discovered while writing these tests.
let knownBugs = 0;
function knownBug(name, cond, note) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    knownBugs++;
    console.log(`  KNOWN-BUG  ${name} -- ${note}`);
  }
}

// =====================================================================================
// Mock fetch: records every request and returns scripted responses in order.
// =====================================================================================

/**
 * Build a fake HttpResponse (matches ports.ts HttpResponse: ok/status/headers/text()/json()/body).
 * Spec-accurate body-consumption semantics: a real Response's body stream can only be read once
 * (via either .json() or .text()) — a second read rejects. Reproducing that here is what makes the
 * B1 regression (toError() calling .json() then falling back to .text() on the SAME response)
 * actually exercised by these tests instead of silently passing against a too-lenient mock.
 */
function makeResponse({ status = 200, json, text, headers = {} }) {
  const bodyText = json !== undefined ? JSON.stringify(json) : text !== undefined ? text : '';
  let consumed = false;
  const consume = () => {
    if (consumed) return Promise.reject(new TypeError('Body is unusable: body stream already read'));
    consumed = true;
    return Promise.resolve();
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      await consume();
      return JSON.parse(bodyText);
    },
    async text() {
      await consume();
      return bodyText;
    },
    body: null,
  };
}

/**
 * Installs a scripted fetch stub through the real seam (bindHttp) — and mirrors it onto
 * globalThis.fetch — that pops the next scripted response off `script` for each call and
 * records the call in `requests`. Throws if the script runs out (keeps tests honest about
 * exactly how many requests a flow issues).
 */
function installFetchStub(script) {
  const requests = [];
  let i = 0;
  const stub = async (input, init) => {
    requests.push({ url: input, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
    if (i >= script.length) throw new Error(`fetch stub: no scripted response left for call #${i + 1} (${input})`);
    const next = script[i++];
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === 'function') return next(input, init);
    return makeResponse(next);
  };
  bindHttp(stub);
  globalThis.fetch = stub;
  return requests;
}

const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// =====================================================================================
// 1) GitLab: project path containing "/" is percent-encoded in the API URL
// =====================================================================================
{
  const requests = installFetchStub([
    { status: 201, json: { iid: 42, id: 999, web_url: 'https://gitlab.example.com/group/sub/repo/-/issues/42' } },
  ]);
  await createGitLabIssue({
    baseUrl: 'https://gitlab.example.com',
    token: 'glpat-abc',
    project: 'group/sub/repo',
    title: 'T',
    body: 'B',
    images: [],
  });
  check('gitlab: nested project path is percent-encoded (group%2Fsub%2Frepo)', requests[0].url.includes('/api/v4/projects/group%2Fsub%2Frepo/issues'));
  check('gitlab: encodeProjectId encodes slashes as %2F directly', encodeProjectId('group/sub/repo') === 'group%2Fsub%2Frepo');
  check('gitlab: encodeProjectId leaves a numeric id untouched', encodeProjectId('12345') === '12345');
}

// =====================================================================================
// 2) GitLab: create-issue request method/headers/payload
// =====================================================================================
{
  const requests = installFetchStub([
    { status: 201, json: { iid: 7, id: 70, web_url: 'https://gitlab.example.com/g/p/-/issues/7' } },
  ]);
  await createGitLabIssue({
    baseUrl: 'https://gitlab.example.com',
    token: 'glpat-secret',
    project: 'g/p',
    title: 'Broken button',
    body: 'It does not click',
    images: [],
  });
  const req = requests[0];
  check('gitlab: create-issue uses POST', req.method === 'POST');
  check('gitlab: create-issue auth header is PRIVATE-TOKEN (not Bearer)', req.headers['PRIVATE-TOKEN'] === 'glpat-secret' && req.headers.Authorization === undefined);
  check('gitlab: create-issue sends JSON content-type', req.headers['Content-Type'] === 'application/json');
  const payload = JSON.parse(req.body);
  check('gitlab: create-issue payload carries title', payload.title === 'Broken button');
  check('gitlab: create-issue payload carries description', payload.description === 'It does not click');
}

// =====================================================================================
// 3) GitLab: attachment upload flow — upload markdown/url ends up embedded in description
// =====================================================================================
{
  // 3a) Upload response has `markdown` -> used verbatim.
  {
    const requests = installFetchStub([
      { status: 201, json: { markdown: '![shot](/uploads/abc/shot.png)', url: '/uploads/abc/shot.png' } },
      { status: 201, json: { iid: 1, id: 10, web_url: 'https://gitlab.example.com/g/p/-/issues/1' } },
    ]);
    await createGitLabIssue({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      project: 'g/p',
      title: 'T',
      body: 'Body text',
      images: [{ dataUrl: png1x1, filename: 'shot.png' }],
    });
    const uploadReq = requests[0];
    check('gitlab: upload request hits the uploads endpoint', uploadReq.url.endsWith('/api/v4/projects/g%2Fp/uploads'));
    check('gitlab: upload request has no explicit Content-Type (multipart boundary is transport-set)', uploadReq.headers['Content-Type'] === undefined);
    const createPayload = JSON.parse(requests[1].body);
    check('gitlab: markdown from upload is embedded in the description', createPayload.description.includes('![shot](/uploads/abc/shot.png)'));
    check('gitlab: original body text is preserved above the embedded image', createPayload.description.startsWith('Body text'));
  }
  // 3b) Upload response has only `url` (no markdown) -> a markdown image link is synthesized.
  {
    const requests = installFetchStub([
      { status: 201, json: { url: '/uploads/def/pic.png' } },
      { status: 201, json: { iid: 2, id: 20, web_url: 'https://gitlab.example.com/g/p/-/issues/2' } },
    ]);
    await createGitLabIssue({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      project: 'g/p',
      title: 'T',
      body: '',
      images: [{ dataUrl: png1x1, filename: 'pic.png' }],
    });
    const createPayload = JSON.parse(requests[1].body);
    check('gitlab: url-only upload response synthesizes markdown image link', createPayload.description === '![pic.png](/uploads/def/pic.png)');
  }
}

// =====================================================================================
// 4) GitLab: non-2xx response surfaces an error mentioning the status (not a raw JSON-parse throw)
// =====================================================================================
{
  // 4a) JSON error body.
  {
    installFetchStub([{ status: 401, json: { message: 'invalid_token' } }]);
    let err;
    try {
      await createGitLabIssue({ baseUrl: 'https://gitlab.example.com', token: 'bad', project: 'g/p', title: 'T', body: 'B', images: [] });
    } catch (e) {
      err = e;
    }
    check('gitlab: non-2xx JSON error rejects with an Error (not a thrown JSON-parse)', err instanceof Error);
    check('gitlab: non-2xx JSON error message mentions the HTTP status', /401/.test(err && err.message));
    check('gitlab: non-2xx JSON error message surfaces the server detail', /invalid_token/.test(err && err.message));
  }
  // 4b) Non-JSON (HTML) error body — the body stream can only be read once (see makeResponse),
  //     so toError() must read it via resp.text() a single time and JSON.parse that string,
  //     not call resp.json() first and then fall back to a second resp.text() read (which
  //     would reject on a real Response and previously got swallowed by an empty catch).
  {
    installFetchStub([{ status: 502, text: '<html><body>502 Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } }]);
    let err;
    try {
      await createGitLabIssue({ baseUrl: 'https://gitlab.example.com', token: 'bad', project: 'g/p', title: 'T', body: 'B', images: [] });
    } catch (e) {
      err = e;
    }
    check('gitlab: non-JSON (HTML) error body does not throw an unhandled JSON-parse error', err instanceof Error);
    check('gitlab: non-JSON (HTML) error message mentions the HTTP status', /502/.test(err && err.message));
    check('gitlab: non-JSON (HTML) error message includes the raw body text as detail', /Bad Gateway/.test(err && err.message));
  }
}

// =====================================================================================
// 5) YouTrack: create-issue payload shape + Authorization: Bearer header
// =====================================================================================
{
  const requests = installFetchStub([
    { status: 200, json: { id: '0-1', idReadable: 'PROJ-1' } }, // create
  ]);
  await createYouTrackIssue({
    baseUrl: 'https://yt.example.com',
    token: 'perm:abc123',
    project: '0-1', // internal id form skips the project-lookup call
    title: 'Crash on save',
    body: 'Steps to repro...',
    images: [],
  });
  const req = requests[0];
  check('youtrack: create-issue uses POST', req.method === 'POST');
  check('youtrack: create-issue hits /api/issues', req.url.includes('/api/issues?fields=id,idReadable'));
  check('youtrack: create-issue Authorization header is Bearer <token>', req.headers.Authorization === 'Bearer perm:abc123');
  const payload = JSON.parse(req.body);
  check('youtrack: create-issue payload nests the project id object', payload.project && payload.project.id === '0-1');
  check('youtrack: create-issue payload carries summary (title)', payload.summary === 'Crash on save');
  check('youtrack: create-issue payload carries description (body)', payload.description === 'Steps to repro...');
}

// =====================================================================================
// 6) YouTrack: attachment two-step flow issues the expected sequence of requests
// =====================================================================================
{
  const requests = installFetchStub([
    { status: 200, json: { id: '0-5', idReadable: 'PROJ-5' } }, // 1. create issue
    { status: 200, json: { name: 'shot.png' } }, // 2. upload attachment
    { status: 200, json: { id: '0-5' } }, // 3. update description (embed)
  ]);
  const result = await createYouTrackIssue({
    baseUrl: 'https://yt.example.com',
    token: 'perm:abc123',
    project: '0-1',
    title: 'T',
    body: 'Body',
    images: [{ dataUrl: png1x1, filename: 'shot.png' }],
  });
  check('youtrack: attachment flow issues exactly 3 requests (create, upload, embed)', requests.length === 3);
  check('youtrack: step 1 creates the issue', requests[0].url.includes('/api/issues?fields=id,idReadable'));
  check('youtrack: step 2 uploads to the issue-scoped attachments endpoint', requests[1].url.includes('/api/issues/0-5/attachments?fields=id,name'));
  check('youtrack: step 3 embeds via a description-only update to the issue', requests[2].url.includes('/api/issues/0-5?fields=id') && JSON.parse(requests[2].body).description !== undefined);
  check('youtrack: step 3 embeds the attachment by its server-returned name', JSON.parse(requests[2].body).description.includes('![shot.png](shot.png)'));
  check('youtrack: result references the human-readable id', result.number === 'PROJ-5' && result.url.includes('/issue/PROJ-5'));
}

// =====================================================================================
// 6b) YouTrack: non-JSON (HTML) error body — same single-read toError() fix as GitLab.
// =====================================================================================
{
  installFetchStub([{ status: 502, text: '<html><body>502 Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } }]);
  let err;
  try {
    await createYouTrackIssue({ baseUrl: 'https://yt.example.com', token: 'perm:abc', project: '0-1', title: 'T', body: 'B', images: [] });
  } catch (e) {
    err = e;
  }
  check('youtrack: non-JSON (HTML) error body does not throw an unhandled JSON-parse error', err instanceof Error);
  check('youtrack: non-JSON (HTML) error message mentions the HTTP status', /502/.test(err && err.message));
  check('youtrack: non-JSON (HTML) error message includes the raw body text as detail', /Bad Gateway/.test(err && err.message));
}

// =====================================================================================
// 6c) YouTrack: project lookup with no exact shortName/name match must NOT silently fall
//     back to the first fuzzy search result — it must reject naming the configured project.
// =====================================================================================
{
  installFetchStub([
    { status: 200, json: [{ id: '0-9', shortName: 'OTHER', name: 'Some Other Project' }] },
  ]);
  let err;
  try {
    await createYouTrackIssue({ baseUrl: 'https://yt.example.com', token: 'perm:abc', project: 'NOPE', title: 'T', body: 'B', images: [] });
  } catch (e) {
    err = e;
  }
  check('youtrack: project with no exact match rejects (does not create an issue)', err instanceof Error);
  check('youtrack: no-exact-match error names the configured project', err && err.message.includes('NOPE'));
  check('youtrack: no-exact-match error lists the fuzzy-search candidate shortNames', err && err.message.includes('OTHER'));
}

// =====================================================================================
// 7) Trailing-slash base URL produces no double-slash in request URLs (both providers)
// =====================================================================================
{
  const requests = installFetchStub([
    { status: 201, json: { iid: 3, id: 30, web_url: 'https://gitlab.example.com/g/p/-/issues/3' } },
  ]);
  await createGitLabIssue({ baseUrl: 'https://gitlab.example.com/', token: 'tok', project: 'g/p', title: 'T', body: 'B', images: [] });
  check('gitlab: trailing-slash baseUrl -> no double slash before /api', !requests[0].url.includes('.com//api') && requests[0].url.startsWith('https://gitlab.example.com/api/v4/'));
}
{
  const requests = installFetchStub([{ status: 200, json: { id: '0-1', idReadable: 'PROJ-1' } }]);
  await createYouTrackIssue({ baseUrl: 'https://yt.example.com/', token: 'perm:abc', project: '0-1', title: 'T', body: 'B', images: [] });
  check('youtrack: trailing-slash baseUrl -> no double slash before /api', !requests[0].url.includes('.com//api') && requests[0].url.startsWith('https://yt.example.com/api/'));
}

// =====================================================================================
// 8) fetch rejection (network down) surfaces an error rather than an unhandled rejection
// =====================================================================================
{
  installFetchStub([new Error('getaddrinfo ENOTFOUND gitlab.example.com')]);
  let err;
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.once('unhandledRejection', onUnhandled);
  try {
    await createGitLabIssue({ baseUrl: 'https://gitlab.example.com', token: 'tok', project: 'g/p', title: 'T', body: 'B', images: [] });
  } catch (e) {
    err = e;
  }
  // Give the microtask queue a tick so a would-be unhandledRejection has a chance to fire.
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', onUnhandled);
  check('gitlab: a network-down fetch rejection is caught and surfaced as an Error', err instanceof Error && /ENOTFOUND/.test(err.message));
  check('gitlab: no unhandledRejection escapes the network-down case', !unhandled);
}
{
  installFetchStub([new Error('network down')]);
  let err;
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.once('unhandledRejection', onUnhandled);
  try {
    await createYouTrackIssue({ baseUrl: 'https://yt.example.com', token: 'tok', project: '0-1', title: 'T', body: 'B', images: [] });
  } catch (e) {
    err = e;
  }
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', onUnhandled);
  check('youtrack: a network-down fetch rejection is caught and surfaced as an Error', err instanceof Error && /network down/.test(err.message));
  check('youtrack: no unhandledRejection escapes the network-down case', !unhandled);
}

console.log(`\n${pass} passed, ${fail} failed${knownBugs ? `, ${knownBugs} known-bug case(s) flagged (not counted as failures)` : ''}`);
process.exit(fail ? 1 : 0);
