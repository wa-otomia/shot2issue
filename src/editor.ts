// Editor page (also the main selection surface): renders the staged screenshot on a
// canvas, lets the user pick a workspace/type, annotate, fill in a title/description, and
// submit through the workspace's provider.
//
// The screenshot comes from chrome.storage.session, written by the service worker when
// the toolbar icon was clicked (or the keyboard shortcut was used).

import { getConfig, getPendingShot, clearPendingShot, rememberSelection } from './lib/storage.js';
import { setLanguage, localizeDom, t } from './lib/i18n.js';
import { getProvider } from './lib/providers/index.js';
import type { Config, Workspace, PendingShot, IssueResult } from './lib/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Workspace backend kind; workspaces created before this field default to GitHub. */
const wsKind = (ws: Workspace): string => ws.kind || 'github';
/** Human-readable label for a workspace option, tagged with its backend. */
function wsLabel(ws: Workspace): string {
  const provider = getProvider(wsKind(ws));
  const base = ws.name || provider.describe(ws) || wsKind(ws);
  return `${base} (${provider.label})`;
}

/** One annotation operation. Rectangle/arrow/mosaic use x0..y1; text uses x/y/size/text. */
interface Op {
  tool: string;
  color: string;
  width?: number;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  points?: Array<{ x: number; y: number }>; // freehand pen path
  size?: number;
  x?: number;
  y?: number;
  text?: string;
}

// ---- DOM ----
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const canvas = $('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const canvasWrap = $('canvasWrap');
const textInput = $('textInput') as HTMLTextAreaElement;
const els = {
  canvasEmpty: $('canvasEmpty'),
  color: $('color') as HTMLInputElement,
  width: $('width') as HTMLInputElement,
  undo: $('undo'),
  clear: $('clear'),
  download: $('download'),
  workspace: $('workspace') as HTMLSelectElement,
  type: $('type') as HTMLSelectElement,
  title: $('title') as HTMLInputElement,
  body: $('body') as HTMLTextAreaElement,
  submit: $('submit') as HTMLButtonElement,
  submitNoImage: $('submitNoImage') as HTMLButtonElement,
  status: $('status'),
  result: $('result'),
  loginState: $('loginState'),
  openOptions: $('openOptions'),
};

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- State ----
let config!: Config;
let pending: PendingShot | null = null;
const baseImage = new Image(); // source screenshot (used for redraw and mosaic sampling)
let ops: Op[] = []; // annotation ops
let currentTool = 'rect';
let drawing: Op | null = null; // in-progress drag op
let pendingTextOp: Op | null = null; // op being entered via the floating text input
let titleDirty = false; // true once the user edits the title (stop auto-filling the default)

// ============================================================================
// 1) Init: load config + staged screenshot, populate the form and canvas
// ============================================================================
async function init(): Promise<void> {
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

  // Draw the screenshot. The canvas backing store equals the image's native pixels for a
  // crisp export; CSS max-width:100% scales it down for display.
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    redraw();
  };
  baseImage.onerror = () => setStatus(t('statusImageLoadFailed'), 'error');
  baseImage.src = pending.dataUrl;

  void refreshLoginHint();
}

function populateSelects(): void {
  els.workspace.innerHTML = '';
  for (const ws of config.workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = wsLabel(ws);
    els.workspace.appendChild(opt);
  }
  const wsId = (pending && pending.workspaceId) || config.lastWorkspaceId;
  if (wsId && config.workspaces.some((w) => w.id === wsId)) els.workspace.value = wsId;

  els.type.innerHTML = '';
  for (const ty of config.types) {
    const opt = document.createElement('option');
    opt.value = ty;
    opt.textContent = ty;
    els.type.appendChild(opt);
  }
  if (pending && pending.type && config.types.includes(pending.type)) els.type.value = pending.type;
}

function defaultTitle(): string {
  const ty = els.type.value || '';
  return [(pending && pending.pageTitle) || '', ty].filter(Boolean).join(' ').trim();
}

function setupDefaults(): void {
  els.title.value = defaultTitle();
  const pageUrl = (pending && pending.pageUrl) || '';
  els.body.value = pageUrl ? t('bodyDefaultPage', [pageUrl]) + '\n\n' : '';
}

els.title.addEventListener('input', () => {
  titleDirty = true;
});

els.type.addEventListener('change', () => {
  void rememberSelection({ type: els.type.value });
  if (!titleDirty) els.title.value = defaultTitle();
});
els.workspace.addEventListener('change', () => {
  void rememberSelection({ workspaceId: els.workspace.value });
  void refreshLoginHint();
});

async function refreshLoginHint(): Promise<void> {
  const ws = selectedWorkspace();
  if (!ws) {
    els.loginState.textContent = '';
    return;
  }
  try {
    const { text, ok } = await getProvider(wsKind(ws)).hint(ws, t);
    els.loginState.textContent = text;
    els.loginState.style.color = ok ? 'var(--muted)' : 'var(--danger)';
  } catch (e) {
    els.loginState.textContent = t('loginUnknown', [e instanceof Error ? e.message : String(e)]);
    els.loginState.style.color = 'var(--danger)';
  }
}

// ============================================================================
// 2) Annotation engine (native canvas)
//    Approach: base image + a replayable list of ops. On every change: clear, draw the
//    base image, replay ops, then draw the in-progress preview. Undo pops the last op.
// ============================================================================

$('toolbar').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.tool') as HTMLElement | null;
  if (!btn) return;
  currentTool = btn.dataset.tool || 'rect';
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b === btn));
  commitTextIfAny();
});

els.undo.addEventListener('click', () => {
  commitTextIfAny();
  ops.pop();
  redraw();
});
els.clear.addEventListener('click', () => {
  commitTextIfAny();
  ops = [];
  redraw();
});

// Page-level shortcuts:
//   Esc        → close this editor tab
//   Ctrl/Cmd+Z → undo the last annotation (native undo still works inside text fields)
function closeEditorTab(): void {
  chrome.tabs
    .getCurrent()
    .then((tab) => {
      if (tab && tab.id != null) void chrome.tabs.remove(tab.id);
    })
    .catch(() => {});
}
window.addEventListener('keydown', (e) => {
  if (e.target === textInput) return; // the text-tool input manages its own keys
  if (e.key === 'Escape') {
    closeEditorTab();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // leave text undo alone
    e.preventDefault();
    commitTextIfAny();
    ops.pop();
    redraw();
  }
});

/** Map screen coordinates to canvas pixel coordinates (the canvas is scaled by CSS). */
function toCanvasXY(evt: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
}

canvas.addEventListener('mousedown', (e) => {
  if (!baseImage.src) return;
  const p = toCanvasXY(e);
  if (currentTool === 'text') {
    openTextInput(p, e);
    return;
  }
  if (currentTool === 'pen') {
    drawing = { tool: 'pen', color: els.color.value, width: Number(els.width.value), points: [{ x: p.x, y: p.y }] };
    return;
  }
  drawing = {
    tool: currentTool,
    color: els.color.value,
    width: Number(els.width.value),
    x0: p.x,
    y0: p.y,
    x1: p.x,
    y1: p.y,
  };
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const p = toCanvasXY(e);
  if (drawing.tool === 'pen') {
    drawing.points?.push({ x: p.x, y: p.y });
  } else {
    drawing.x1 = p.x;
    drawing.y1 = p.y;
  }
  redraw();
});

window.addEventListener('mouseup', () => {
  if (!drawing) return;
  if (drawing.tool === 'pen') {
    if ((drawing.points?.length ?? 0) > 1) ops.push(drawing);
  } else {
    const moved = Math.hypot((drawing.x1 ?? 0) - (drawing.x0 ?? 0), (drawing.y1 ?? 0) - (drawing.y0 ?? 0)) > 3;
    if (moved) ops.push(drawing);
  }
  drawing = null;
  redraw();
});

// Text tool: float a transparent textarea over the canvas so you type directly on the
// image. The font size tracks the current width (WYSIWYG); the on-screen size accounts
// for the canvas being scaled to fit. Enter inserts a newline; Ctrl/Cmd+Enter or clicking
// away commits; Esc cancels.
function openTextInput(p: { x: number; y: number }, evt: MouseEvent): void {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const size = Math.max(14, Number(els.width.value) * 5); // backing-pixel size (as rendered)
  const scale = canvas.width ? canvas.getBoundingClientRect().width / canvas.width : 1;
  textInput.style.left = evt.clientX - wrapRect.left + 'px';
  textInput.style.top = evt.clientY - wrapRect.top + 'px';
  textInput.style.fontSize = size * scale + 'px';
  textInput.style.color = els.color.value;
  textInput.style.display = 'block';
  textInput.value = '';
  pendingTextOp = { tool: 'text', color: els.color.value, size, x: p.x, y: p.y };
  autoSizeTextInput();
  setTimeout(() => textInput.focus(), 0);
}

/** Grow the transparent textarea to fit its content (wrap is off, so it matches render). */
function autoSizeTextInput(): void {
  textInput.style.width = '2px';
  textInput.style.width = Math.max(textInput.scrollWidth + 4, 12) + 'px';
  textInput.style.height = 'auto';
  textInput.style.height = textInput.scrollHeight + 'px';
}

function commitTextIfAny(): void {
  if (textInput.style.display !== 'none' && textInput.value.trim() && pendingTextOp) {
    ops.push({ ...pendingTextOp, text: textInput.value.replace(/\n+$/, '') });
  }
  textInput.style.display = 'none';
  textInput.blur(); // drop focus so a later Esc closes the editor instead of being swallowed
  pendingTextOp = null;
  redraw();
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commitTextIfAny();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    textInput.style.display = 'none';
    textInput.blur();
    pendingTextOp = null;
  }
});
textInput.addEventListener('input', autoSizeTextInput);
textInput.addEventListener('blur', commitTextIfAny);

/** Redraw the whole canvas: base image + committed ops + the in-progress preview. */
function redraw(): void {
  if (!canvas.width) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  for (const op of ops) drawOp(op);
  if (drawing) drawOp(drawing);
}

function drawOp(op: Op): void {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.width || 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (op.tool === 'rect') {
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    ctx.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  } else if (op.tool === 'arrow') {
    drawArrow(op);
  } else if (op.tool === 'pen') {
    drawPen(op);
  } else if (op.tool === 'mosaic') {
    drawMosaic(op);
  } else if (op.tool === 'text') {
    const size = op.size || 20;
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, size / 8);
    const lineHeight = size * 1.2;
    (op.text || '').split('\n').forEach((line, i) => {
      const ly = (op.y ?? 0) + i * lineHeight;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(line, op.x ?? 0, ly);
      ctx.fillStyle = op.color;
      ctx.fillText(line, op.x ?? 0, ly);
    });
  }
  ctx.restore();
}

/** Stroke a freehand pen path. */
function drawPen(op: Op): void {
  const pts = op.points || [];
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawArrow(op: Op): void {
  const x0 = op.x0 ?? 0;
  const y0 = op.y0 ?? 0;
  const x1 = op.x1 ?? 0;
  const y1 = op.y1 ?? 0;
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
function drawMosaic(op: Op): void {
  const x = Math.round(Math.min(op.x0 ?? 0, op.x1 ?? 0));
  const y = Math.round(Math.min(op.y0 ?? 0, op.y1 ?? 0));
  const w = Math.round(Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)));
  const h = Math.round(Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  if (w < 2 || h < 2) return;
  const block = 12;
  const sw = Math.max(1, Math.floor(w / block));
  const sh = Math.max(1, Math.floor(h / block));
  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext('2d') as CanvasRenderingContext2D;
  tctx.drawImage(baseImage, x, y, w, h, 0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  ctx.restore();
}

// ============================================================================
// 3) Export / download
// ============================================================================
function canvasToDataUrl(): string {
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
// 4) Submit (delegated to the workspace's provider)
// ============================================================================
function setStatus(text: string, cls: 'info' | 'error' | 'ok' = 'info'): void {
  els.status.className = cls;
  els.status.textContent = text;
}
function setStatusBusy(text: string): void {
  els.status.className = 'info';
  els.status.innerHTML = `<span class="spin"></span>${text}`;
}
function disableSubmit(v: boolean): void {
  els.submit.disabled = v;
  els.submitNoImage.disabled = v;
}

function selectedWorkspace(): Workspace | null {
  return config.workspaces.find((w) => w.id === els.workspace.value) || null;
}

/** Validate preconditions. Returns { ws } or throws. */
function preflight(): { ws: Workspace } {
  if (!pending) throw new Error(t('errNoShot'));
  const ws = selectedWorkspace();
  if (!ws) throw new Error(t('errSelectWorkspace'));
  const errKey = getProvider(wsKind(ws)).validate(ws);
  if (errKey) throw new Error(t(errKey));
  if (!els.title.value.trim()) throw new Error(t('errTitleEmpty'));
  return { ws };
}

els.submit.addEventListener('click', () => void submit({ withImage: true }));
els.submitNoImage.addEventListener('click', () => void submit({ withImage: false }));

async function submit({ withImage }: { withImage: boolean }): Promise<void> {
  commitTextIfAny();
  els.result.innerHTML = '';
  let ws: Workspace;
  try {
    ({ ws } = preflight());
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
    return;
  }

  disableSubmit(true);
  try {
    const issue: IssueResult = await getProvider(wsKind(ws)).submit(ws, {
      title: els.title.value.trim(),
      body: els.body.value,
      dataUrl: withImage ? canvasToDataUrl() : '',
      filename: `shot-${Date.now()}.png`,
      withImage,
      t,
      busy: (key: string) => setStatusBusy(t(key)),
    });

    const num = issue.number || '';
    showResult(issue);
    await clearPendingShot();

    // Optionally return to the captured tab and close this editor tab.
    if (config.closeAfterSubmit && pending && pending.sourceTabId != null) {
      setStatus(num ? t('statusReturning', [num]) : t('statusCreatedNoNumber'), 'ok');
      await sleep(900);
      try {
        await chrome.tabs.update(pending.sourceTabId, { active: true });
      } catch {
        /* the source tab may be gone */
      }
      try {
        const me = await chrome.tabs.getCurrent();
        if (me && me.id != null) await chrome.tabs.remove(me.id);
      } catch {
        /* ignore */
      }
      return;
    }

    setStatus(num ? t('statusCreated', [num]) : t('statusCreatedNoNumber'), 'ok');
  } catch (err) {
    console.error(err);
    setStatus(t('statusSubmitFailed', [err instanceof Error ? err.message : String(err)]), 'error');
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

function showResult(issue: IssueResult): void {
  els.result.innerHTML = '';
  const a = document.createElement('a');
  a.href = issue.url;
  a.textContent = issue.url;
  a.target = '_blank';
  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = t('openIssue');
  open.style.marginLeft = '10px';
  open.addEventListener('click', () => chrome.tabs.create({ url: issue.url }));
  const wrap = document.createElement('div');
  wrap.appendChild(a);
  wrap.appendChild(open);
  els.result.appendChild(wrap);
}

void init();
