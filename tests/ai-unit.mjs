// Unit tests for the pure helpers in lib/ai.ts (no chrome, no network).
// Run after `npm run build`:  node tests/ai-unit.mjs

import { createHash } from 'node:crypto';
import {
  genPkce,
  randomState,
  buildAuthorizeUrl,
  parseRedirect,
  parseJwt,
  accountInfoFromIdToken,
  parseQuotaHeaders,
  buildTitlePrompt,
  buildResponsesRequest,
  cleanTitle,
  extractOutputText,
  normalizeModel,
  isValidModelSlug,
  parseModelsResponse,
  DEFAULT_MODELS,
  DEFAULT_TITLE_PROMPT,
  CLIENT_ID,
} from '../build/lib/ai.js';

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

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// --- PKCE ---
const { verifier, challenge } = await genPkce();
check('pkce: verifier is base64url and long enough', /^[A-Za-z0-9_-]{43,}$/.test(verifier));
check('pkce: challenge = base64url(sha256(verifier))', challenge === createHash('sha256').update(verifier).digest('base64url'));
check('state: two calls differ', randomState() !== randomState());

// --- authorize URL ---
const url = buildAuthorizeUrl({ redirectUri: 'http://localhost:1455/auth/callback', challenge, state: 'st8' });
const u = new URL(url);
check('authorize: host is auth.openai.com', u.host === 'auth.openai.com');
check('authorize: client_id', u.searchParams.get('client_id') === CLIENT_ID);
check('authorize: response_type=code', u.searchParams.get('response_type') === 'code');
check('authorize: S256', u.searchParams.get('code_challenge_method') === 'S256');
check('authorize: carries challenge + state + redirect', u.searchParams.get('code_challenge') === challenge && u.searchParams.get('state') === 'st8' && u.searchParams.get('redirect_uri') === 'http://localhost:1455/auth/callback');

// --- parseRedirect ---
check('redirect: localhost URL', JSON.stringify(parseRedirect('http://localhost:1455/auth/callback?code=AC&state=ST')) === JSON.stringify({ code: 'AC', state: 'ST' }));
check('redirect: chromiumapp URL', parseRedirect('https://abc.chromiumapp.org/?code=XY&state=Q').code === 'XY');
check('redirect: bare query', parseRedirect('code=BARE&state=Z').code === 'BARE');
check('redirect: leading ? tolerated', parseRedirect('?code=Q1').code === 'Q1');
let threwErr = false;
try { parseRedirect('error=access_denied&error_description=nope'); } catch { threwErr = true; }
check('redirect: throws on error param', threwErr);
let threwNoCode = false;
try { parseRedirect('state=only'); } catch { threwNoCode = true; }
check('redirect: throws when code missing', threwNoCode);

// --- JWT / account info ---
const idToken = ['x', b64url({ email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123', chatgpt_plan_type: 'pro', chatgpt_user_id: 'usr_9' } }), 'sig'].join('.');
const claims = parseJwt(idToken);
check('jwt: parses payload', claims.email === 'dev@example.com');
const info = accountInfoFromIdToken(idToken);
check('jwt: account id', info.accountId === 'acc_123');
check('jwt: plan type', info.planType === 'pro');
check('jwt: email', info.email === 'dev@example.com');
check('jwt: bad token yields empty info', Object.keys(accountInfoFromIdToken('not-a-jwt')).every((k) => accountInfoFromIdToken('not-a-jwt')[k] === undefined));

// --- quota headers ---
const q = parseQuotaHeaders(new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-secondary-used-percent': '7', 'x-other': 'ignored' }), 1000);
check('quota: primary percent', q && q.primaryUsedPercent === 42);
check('quota: secondary percent', q && q.secondaryUsedPercent === 7);
check('quota: only x-codex headers captured', q && !('x-other' in q.raw) && 'x-codex-primary-used-percent' in q.raw);
check('quota: none -> undefined', parseQuotaHeaders(new Headers({ 'content-type': 'text/plain' }), 1) === undefined);

// --- prompt ---
const prompt = buildTitlePrompt({ type: 'Bug', pageTitle: 'Dash', pageUrl: 'https://x/y', body: 'Save button overlaps footer' });
check('prompt: instructions mention title', /title/i.test(prompt.instructions));
check('prompt: input carries body + type', prompt.input.includes('Save button overlaps footer') && prompt.input.includes('Bug'));
check('prompt: custom instructions are used when provided', buildTitlePrompt({ body: 'x' }, 'CUSTOM PROMPT').instructions === 'CUSTOM PROMPT');
check('prompt: defaults to built-in when not provided', buildTitlePrompt({ body: 'x' }).instructions === DEFAULT_TITLE_PROMPT);

// --- responses request shape (Codex backend requires input to be a typed message list) ---
const reqBody = buildResponsesRequest({ model: 'gpt-5.5', instructions: 'sys', input: 'hello world' });
check('responses: input is a list', Array.isArray(reqBody.input));
check('responses: input item is a typed user message',
  reqBody.input[0].type === 'message' &&
    reqBody.input[0].role === 'user' &&
    reqBody.input[0].content[0].type === 'input_text' &&
    reqBody.input[0].content[0].text === 'hello world');
check('responses: carries model + instructions', reqBody.model === 'gpt-5.5' && reqBody.instructions === 'sys');

// --- cleanTitle ---
check('clean: strips quotes', cleanTitle('"Hello world"') === 'Hello world');
check('clean: first line only', cleanTitle('Title line\nextra') === 'Title line');
check('clean: trailing punctuation removed', cleanTitle('Fix the bug.') === 'Fix the bug');
check('clean: length capped', cleanTitle('x'.repeat(200)).length === 120);

// --- extractOutputText ---
check('extract: json output_text', extractOutputText(JSON.stringify({ output_text: 'Direct' }), 'application/json') === 'Direct');
check('extract: json nested output', extractOutputText(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'Nested' }] }] }), 'application/json') === 'Nested');
const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"there"}\n\ndata: [DONE]\n';
check('extract: sse deltas concatenated', extractOutputText(sse, 'text/event-stream') === 'Hello there');

// --- model slugs (dotted Codex models, not dashed consumer slugs) ---
check('models: default list uses dotted Codex slugs', DEFAULT_MODELS.includes('gpt-5.5') && !DEFAULT_MODELS.includes('gpt-5-5'));
check('models: normalize keeps a valid model', normalizeModel('gpt-5.4') === 'gpt-5.4');
check('models: normalize coerces a bad web slug to the default', normalizeModel('gpt-5-5') === DEFAULT_MODELS[0]);
check('models: normalize handles undefined', normalizeModel(undefined) === DEFAULT_MODELS[0]);
check('models: normalize honors an allowed list', normalizeModel('gpt-6.0', ['gpt-6.0', 'gpt-5.5']) === 'gpt-6.0');
check('models: isValidModelSlug accepts dotted, rejects dashed', isValidModelSlug('gpt-5.5') && isValidModelSlug('gpt-6.1-codex') && !isValidModelSlug('gpt-5-5'));
// parseModelsResponse: visibility filter, priority sort, dashed-slug drop
const modelsBody = JSON.stringify({
  models: [
    { slug: 'gpt-5.4', priority: 2, visibility: 'list' },
    { slug: 'gpt-5.5', priority: 1, visibility: 'list' },
    { slug: 'gpt-5.3-hidden', priority: 0, visibility: 'hide' },
    { slug: 'gpt-5-5', priority: 3, visibility: 'list' },
  ],
});
check('models: parse sorts by priority + filters visibility/dashed',
  JSON.stringify(parseModelsResponse(modelsBody)) === JSON.stringify(['gpt-5.5', 'gpt-5.4']));
check('models: parse returns [] on garbage', parseModelsResponse('not json').length === 0);

// --- responses request: images become input_image parts ---
const reqImg = buildResponsesRequest({ model: 'gpt-5.5', instructions: 'i', input: 'x', images: ['data:image/png;base64,AAAA'] });
check('responses: image is added as input_image', reqImg.input[0].content.length === 2 && reqImg.input[0].content[1].type === 'input_image' && reqImg.input[0].content[1].image_url === 'data:image/png;base64,AAAA');
check('responses: no image -> only text part', buildResponsesRequest({ model: 'm', instructions: 'i', input: 'x' }).input[0].content.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
