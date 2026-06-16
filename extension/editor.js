// Editor page (also the main selection surface): renders the staged screenshot on a
// canvas, lets the user pick a workspace/type, annotate, fill in a title/description,
// and submit. Submission runs in a background github.com tab; no token is required.
//
// The screenshot comes from chrome.storage.session, written by the service worker when
// the toolbar icon was clicked.

import {
  getConfig,
  getPendingShot,
  clearPendingShot,
  rememberSelection,
} from './lib/storage.js';
import { checkGithubLogin } from './lib/github-attach.js';
import { submitIssueViaPage } from './lib/page-upload.js';
import { setLanguage, localizeDom, t } from './lib/i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const canvasWrap = $('canvasWrap');
const textInput = $('textInput');
const els = {
  canvasEmpty: $('canvasEmpty'),
  color: $('color'),
  width: $('width'),
  undo: $('undo'),
  clear: $('clear'),
  download: $('download'),
  workspace: $('workspace'),
  type: $('type'),
  title: $('title'),
  body: $('body'),
  submit: $('submit'),
  submitNoImage: $('submitNoImage'),
  status: $('status'),
  result: $('result'),
  loginState: $('loginState'),
  openOptions: $('openOptions'),
};

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- State ----
let config = null;
let pending = null; // { dataUrl, pageUrl, pageTitle, type, workspaceId, sourceTabId } or { error }
const baseImage = new Image(); // source screenshot (used for redraw and mosaic sampling)
let ops = []; // annotation ops: { tool, color, width, ... }
let currentTool = 'rect';
let drawing = null; // in-progress drag op
let titleDirty = false; // true once the user edits the title (stop auto-filling the default)

// ============================================================================
// 1) Init: load config + staged screenshot, populate the form and canvas
// ============================================================================
async function init() {
  config = await getConfig();
  setLanguage(config.lang);
  localizeDom(document);

  // Show the loaded version next to the title, to confirm reloads picked up new code.
  const h1 = document.querySelector('header h1');
  if (h1) {
    h1.insertAdjacentHTML(
      'beforeend',
      ` <span style="font-weight:400;color:var(--muted);font-size:12px;">v${chrome.runtime.getManifest().version}</span>`
    );
  }

  pending = await getPendingShot();

  // Capture failed (e.g. a restricted page): the worker stages an error to show here.
  if (pending && pending.error) {
    els.canvasEmpty.textContent = pending.error;
    els.canvasEmpty.classList.remove('hidden');
    canvas.classList.add('hidden');
    setStatus(pending.error, 'error');
    disableSubmit(true);
    return;
  }
  if (!pending || !pending.dataUrl) {
    els.canvasEmpty.classList.remove('hidden');
    canvas.classList.add('hidden');
    setStatus(t('statusNoShot'), 'info');
    disableSubmit(true);
    return;
  }

  if (!config.workspaces.length) {
    setStatus(t('statusNeedWorkspace'), 'error');
  }

  populateSelects();
  setupDefaults();

  // Draw the screenshot. The canvas backing store equals the image's native pixels for
  // a crisp export; CSS max-width:100% scales it down for display.
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    redraw();
  };
  baseImage.onerror = () => setStatus(t('statusImageLoadFailed'), 'error');
  baseImage.src = pending.dataUrl;

  refreshLoginHint();
}

function populateSelects() {
  els.workspace.innerHTML = '';
  for (const ws of config.workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = ws.name || `${ws.owner}/${ws.repo}`;
    els.workspace.appendChild(opt);
  }
  const wsId = pending.workspaceId || config.lastWorkspaceId;
  if (wsId && config.workspaces.some((w) => w.id === wsId)) els.workspace.value = wsId;

  els.type.innerHTML = '';
  for (const ty of config.types) {
    const opt = document.createElement('option');
    opt.value = ty;
    opt.textContent = ty;
    els.type.appendChild(opt);
  }
  if (pending.type && config.types.includes(pending.type)) els.type.value = pending.type;
}

function defaultTitle() {
  const ty = els.type.value || '';
  return [pending.pageTitle || '', ty].filter(Boolean).join(' ').trim();
}

function setupDefaults() {
  els.title.value = defaultTitle();
  els.body.value = pending.pageUrl ? t('bodyDefaultPage', [pending.pageUrl]) + '\n\n' : '';
}

els.title.addEventListener('input', () => { titleDirty = true; });

els.type.addEventListener('change', () => {
  rememberSelection({ type: els.type.value });
  if (!titleDirty) els.title.value = defaultTitle();
});
els.workspace.addEventListener('change', () => {
  rememberSelection({ workspaceId: els.workspace.value });
  refreshLoginHint();
});

async function refreshLoginHint() {
  els.loginState.textContent = t('loginChecking');
  els.loginState.style.color = 'var(--muted)';
  try {
    const { loggedIn, login } = await checkGithubLogin();
    els.loginState.textContent = loggedIn ? t('loginSignedInAs', [login]) : '⚠ ' + t('loginNotSignedIn');
    els.loginState.style.color = loggedIn ? 'var(--muted)' : 'var(--danger)';
  } catch (e) {
    els.loginState.textContent = t('loginUnknown', [e && e.message ? e.message : String(e)]);
    els.loginState.style.color = 'var(--danger)';
  }
}

// ============================================================================
// 2) Annotation engine (native canvas)
//    Approach: base image + a replayable list of ops. On every change: clear, draw the
//    base image, replay ops, then draw the in-progress preview. Undo pops the last op.
// ============================================================================

document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tool');
  if (!btn) return;
  currentTool = btn.dataset.tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b === btn));
  commitTextIfAny();
});

els.undo.addEventListener('click', () => { commitTextIfAny(); ops.pop(); redraw(); });
els.clear.addEventListener('click', () => { commitTextIfAny(); ops = []; redraw(); });

/** Map screen coordinates to canvas pixel coordinates (the canvas is scaled by CSS). */
function toCanvasXY(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
}

canvas.addEventListener('mousedown', (e) => {
  if (!baseImage.src) return;
  const p = toCanvasXY(e);
  if (currentTool === 'text') { openTextInput(p, e); return; }
  drawing = {
    tool: currentTool,
    color: els.color.value,
    width: Number(els.width.value),
    x0: p.x, y0: p.y, x1: p.x, y1: p.y,
  };
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const p = toCanvasXY(e);
  drawing.x1 = p.x;
  drawing.y1 = p.y;
  redraw();
});

window.addEventListener('mouseup', () => {
  if (!drawing) return;
  const moved = Math.hypot(drawing.x1 - drawing.x0, drawing.y1 - drawing.y0) > 3;
  if (moved) ops.push(drawing);
  drawing = null;
  redraw();
});

// Text tool: float an input over the canvas; commit a text op on Enter/blur.
function openTextInput(p, evt) {
  const wrapRect = canvasWrap.getBoundingClientRect();
  textInput.style.left = evt.clientX - wrapRect.left + canvasWrap.scrollLeft + 'px';
  textInput.style.top = evt.clientY - wrapRect.top + canvasWrap.scrollTop + 'px';
  textInput.style.display = 'block';
  textInput.style.color = els.color.value;
  textInput.value = '';
  textInput._op = {
    tool: 'text',
    color: els.color.value,
    size: Math.max(14, Number(els.width.value) * 5),
    x: p.x,
    y: p.y,
  };
  setTimeout(() => textInput.focus(), 0);
}

function commitTextIfAny() {
  if (textInput.style.display !== 'none' && textInput.value.trim() && textInput._op) {
    ops.push({ ...textInput._op, text: textInput.value });
  }
  textInput.style.display = 'none';
  textInput._op = null;
  redraw();
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitTextIfAny(); }
  if (e.key === 'Escape') { textInput.style.display = 'none'; textInput._op = null; }
});
textInput.addEventListener('blur', commitTextIfAny);

/** Redraw the whole canvas: base image + committed ops + the in-progress preview. */
function redraw() {
  if (!canvas.width) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  for (const op of ops) drawOp(op);
  if (drawing) drawOp(drawing);
}

function drawOp(op) {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.width || 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (op.tool === 'rect') {
    const x = Math.min(op.x0, op.x1), y = Math.min(op.y0, op.y1);
    ctx.strokeRect(x, y, Math.abs(op.x1 - op.x0), Math.abs(op.y1 - op.y0));
  } else if (op.tool === 'arrow') {
    drawArrow(op);
  } else if (op.tool === 'mosaic') {
    drawMosaic(op);
  } else if (op.tool === 'text') {
    ctx.font = `bold ${op.size || 20}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, (op.size || 20) / 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(op.text, op.x, op.y);
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.x, op.y);
  }
  ctx.restore();
}

function drawArrow(op) {
  const { x0, y0, x1, y1 } = op;
  const head = Math.max(10, (op.width || 4) * 3);
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

/**
 * Mosaic / redaction: sample the region from the base image, downscale it, then draw it
 * back enlarged with smoothing off to produce hard pixel blocks. Sampling the base image
 * (not the current canvas) keeps redaction of the original content stable.
 */
function drawMosaic(op) {
  const x = Math.round(Math.min(op.x0, op.x1));
  const y = Math.round(Math.min(op.y0, op.y1));
  const w = Math.round(Math.abs(op.x1 - op.x0));
  const h = Math.round(Math.abs(op.y1 - op.y0));
  if (w < 2 || h < 2) return;
  const block = 12;
  const sw = Math.max(1, Math.floor(w / block));
  const sh = Math.max(1, Math.floor(h / block));
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(baseImage, x, y, w, h, 0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  ctx.restore();
}

// ============================================================================
// 3) Export / download
// ============================================================================
function canvasToDataUrl() {
  return canvas.toDataURL('image/png');
}

els.download.addEventListener('click', () => {
  commitTextIfAny();
  const a = document.createElement('a');
  a.href = canvasToDataUrl();
  a.download = `shot-${Date.now()}.png`;
  a.click();
});

// ============================================================================
// 4) Submit
// ============================================================================
function setStatus(text, cls = 'info') {
  els.status.className = cls;
  els.status.textContent = text;
}
function setStatusBusy(text) {
  els.status.className = 'info';
  els.status.innerHTML = `<span class="spin"></span>${text}`;
}
function disableSubmit(v) {
  els.submit.disabled = v;
  els.submitNoImage.disabled = v;
}

function selectedWorkspace() {
  return config.workspaces.find((w) => w.id === els.workspace.value) || null;
}

/** Validate preconditions. Returns { ws } or throws. */
function preflight() {
  if (!pending) throw new Error(t('errNoShot'));
  const ws = selectedWorkspace();
  if (!ws) throw new Error(t('errSelectWorkspace'));
  if (!ws.owner || !ws.repo) throw new Error(t('errWorkspaceIncomplete'));
  if (!els.title.value.trim()) throw new Error(t('errTitleEmpty'));
  return { ws };
}

els.submit.addEventListener('click', () => submit({ withImage: true }));
els.submitNoImage.addEventListener('click', () => submit({ withImage: false }));

async function submit({ withImage }) {
  commitTextIfAny();
  els.result.innerHTML = '';
  let ws;
  try {
    ({ ws } = preflight());
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }

  disableSubmit(true);
  try {
    const title = els.title.value.trim();
    const dataUrl = withImage ? canvasToDataUrl() : '';
    const filename = `shot-${Date.now()}.png`;

    // Both upload and creation use the github.com web session; require sign-in.
    setStatusBusy(t('statusCheckingLogin'));
    const { loggedIn, login } = await checkGithubLogin();
    if (!loggedIn) throw new Error(t('errNotSignedIn'));
    els.loginState.textContent = t('loginSignedInAs', [login]);

    setStatusBusy(withImage ? t('statusSubmitting') : t('statusSubmittingNoImage'));
    const url = await submitIssueViaPage({
      owner: ws.owner, repo: ws.repo, title, body: els.body.value, dataUrl, filename, withImage,
    });
    const num = (url.match(/\/issues\/(\d+)/) || [])[1] || '';
    const issue = { html_url: url, number: num };

    showResult(issue);
    await clearPendingShot();

    // Optionally return to the captured tab and close this editor tab.
    if (config.closeAfterSubmit && pending.sourceTabId != null) {
      setStatus(num ? t('statusReturning', [num]) : t('statusCreatedNoNumber'), 'ok');
      await sleep(900);
      try { await chrome.tabs.update(pending.sourceTabId, { active: true }); } catch (_) {}
      try {
        const me = await chrome.tabs.getCurrent();
        if (me) await chrome.tabs.remove(me.id);
      } catch (_) {}
      return;
    }

    setStatus(num ? t('statusCreated', [num]) : t('statusCreatedNoNumber'), 'ok');
  } catch (err) {
    console.error(err);
    setStatus(t('statusSubmitFailed', [err && err.message ? err.message : String(err)]), 'error');
    if (withImage) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = t('retryHint');
      els.result.appendChild(hint);
    }
  } finally {
    disableSubmit(false);
  }
}

function showResult(issue) {
  els.result.innerHTML = '';
  const a = document.createElement('a');
  a.href = issue.html_url;
  a.textContent = issue.html_url;
  a.target = '_blank';
  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = t('openIssue');
  open.style.marginLeft = '10px';
  open.addEventListener('click', () => chrome.tabs.create({ url: issue.html_url }));
  const wrap = document.createElement('div');
  wrap.appendChild(a);
  wrap.appendChild(open);
  els.result.appendChild(wrap);
}

init();
