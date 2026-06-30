// Integration test: AI requests refresh the OAuth token and retry when the server rejects it
// (HTTP 401 — token expired/invalidated), instead of failing outright.
// Mocks chrome.storage.local + fetch. Run after `npm run build`:  node tests/ai-refresh.mjs

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

// --- in-memory chrome.storage.local ---
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys) => {
        if (typeof keys === 'string') return Promise.resolve({ [keys]: store[keys] });
        if (Array.isArray(keys)) {
          const o = {};
          keys.forEach((k) => (o[k] = store[k]));
          return Promise.resolve(o);
        }
        const o = {};
        for (const k in keys || {}) o[k] = k in store ? store[k] : keys[k];
        return Promise.resolve(o);
      },
      set: (obj) => {
        Object.assign(store, obj);
        return Promise.resolve();
      },
    },
  },
};

// --- routed fetch: transcribe/responses reject the old token, the token endpoint mints a new one ---
let calls = [];
const TOKEN = 'oauth/token';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const headers = init.headers || {};
  const auth = headers.Authorization || headers.authorization || '';
  calls.push({ url: u, auth });
  if (u.includes(TOKEN)) {
    return jsonResp({ access_token: 'new-token', refresh_token: 'new-rt', expires_in: 3600 }, 200);
  }
  if (u.includes('/transcribe') || u.includes('/responses')) {
    if (auth.includes('old-token')) {
      return jsonResp({ error: { message: 'Your authentication token has been invalidated.', code: 'token_invalidated' } }, 401);
    }
    if (u.includes('/transcribe')) return jsonResp({ text: 'hello world' }, 200);
    return jsonResp({ output_text: '{"title":"T","body":"B"}' }, 200);
  }
  return jsonResp({ error: 'unexpected route' }, 404);
};

const ai = await import('../build/lib/ai.js');
const storage = await import('../build/lib/storage.js');
const FUTURE = Date.now() + 3600_000;
const PAST = Date.now() - 1000;
const blob = new Blob(['x'], { type: 'audio/webm' });
const seed = (extra) =>
  storage.setAiAuth({ accessToken: 'old-token', refreshToken: 'old-rt', connectedAt: 1, ...extra });

// 1) transcribeAudio: valid-looking local expiry, but the server says 401 → refresh + retry.
calls = [];
await seed({ expiresAt: FUTURE });
const transcript = await ai.transcribeAudio(blob);
check('reactive: transcription succeeds after a 401 refresh+retry', transcript === 'hello world');
check('reactive: the token endpoint was called', calls.some((c) => c.url.includes(TOKEN)));
const txCalls = calls.filter((c) => c.url.includes('/transcribe'));
check('reactive: retried transcription with the new token', txCalls.length === 2 && txCalls[1].auth.includes('new-token'));
check('reactive: refreshed access token was persisted', (await storage.getAiAuth()).accessToken === 'new-token');

// 2) generateComplaint goes through the same refresh path on the responses endpoint.
calls = [];
await seed({ expiresAt: FUTURE, model: 'gpt-5.5', models: ['gpt-5.5'] });
const complaint = await ai.generateComplaint({ transcript: 'the save button is broken' });
check('reactive: complaint generation succeeds after a 401 refresh+retry',
  complaint.title === 'T' && complaint.body === 'B');
check('reactive: complaint refreshed + persisted the new token',
  calls.some((c) => c.url.includes(TOKEN)) && (await storage.getAiAuth()).accessToken === 'new-token');

// 3) Without a refresh token there is nothing to refresh with — fail, don't loop or call /token.
calls = [];
await seed({ expiresAt: FUTURE, refreshToken: undefined });
let threw = false;
try {
  await ai.transcribeAudio(blob);
} catch {
  threw = true;
}
check('no-refresh-token: a 401 surfaces as an error (no retry)', threw);
check('no-refresh-token: the token endpoint was NOT called', !calls.some((c) => c.url.includes(TOKEN)));

// 4) Proactive refresh still works: an already-expired local token refreshes before the request.
calls = [];
await seed({ expiresAt: PAST });
const transcript2 = await ai.transcribeAudio(blob);
check('proactive: expired token refreshed before the request', transcript2 === 'hello world');
check('proactive: request used the new token on the first try',
  calls.filter((c) => c.url.includes('/transcribe')).length === 1 &&
    calls.filter((c) => c.url.includes('/transcribe'))[0].auth.includes('new-token'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
