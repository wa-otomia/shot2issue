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
  num?: number; // numbered-box badge value
  size?: number;
  x?: number;
  y?: number;
  w?: number; // text wrap width (canvas pixels)
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
//   Esc (twice) → close this editor tab (the first press shows a confirmation toast)
//   Ctrl/Cmd+Z  → undo the last annotation (native undo still works inside text fields)
function closeEditorTab(): void {
  chrome.tabs
    .getCurrent()
    .then((tab) => {
      if (tab && tab.id != null) void chrome.tabs.remove(tab.id);
    })
    .catch(() => {});
}

let escArmed = false;
let escTimer: number | undefined;
let toastEl: HTMLElement | null = null;
let toastTimer: number | undefined;
function showToast(message: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), 1600);
}

window.addEventListener('keydown', (e) => {
  if (e.target === textInput) return; // the text-tool input manages its own keys
  if (e.key === 'Escape') {
    if (escArmed) {
      window.clearTimeout(escTimer);
      escArmed = false;
      closeEditorTab();
    } else {
      escArmed = true;
      showToast(t('escAgainToClose'));
      escTimer = window.setTimeout(() => {
        escArmed = false;
      }, 2000);
    }
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
    // Commit any in-progress text first — otherwise starting a new box wipes it — then
    // drag a rectangular region that becomes the (resizable) text box.
    commitTextIfAny();
    drawing = { tool: 'textbox', color: els.color.value, width: Number(els.width.value), x0: p.x, y0: p.y, x1: p.x, y1: p.y };
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
  // Numbered box: assign the next number now so the drag preview shows it. The count is
  // taken from the committed ops, so undo naturally frees the number for the next box.
  if (currentTool === 'numrect') {
    drawing.num = ops.filter((o) => o.tool === 'numrect').length + 1;
  }
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
  if (drawing.tool === 'textbox') {
    // Open the text editor over the dragged region; a plain click → a default-size box.
    const bx = Math.min(drawing.x0 ?? 0, drawing.x1 ?? 0);
    const by = Math.min(drawing.y0 ?? 0, drawing.y1 ?? 0);
    let bw = Math.abs((drawing.x1 ?? 0) - (drawing.x0 ?? 0));
    let bh = Math.abs((drawing.y1 ?? 0) - (drawing.y0 ?? 0));
    const size = Math.max(14, (drawing.width || 4) * 5);
    if (bw < 8 || bh < 8) {
      bw = 240;
      bh = Math.round(size * 1.6);
    }
    const color = drawing.color;
    drawing = null;
    redraw();
    openTextBox(bx, by, bw, bh, size, color);
    return;
  }
  if (drawing.tool === 'pen') {
    if ((drawing.points?.length ?? 0) > 1) ops.push(drawing);
  } else {
    const moved = Math.hypot((drawing.x1 ?? 0) - (drawing.x0 ?? 0), (drawing.y1 ?? 0) - (drawing.y0 ?? 0)) > 3;
    if (moved) ops.push(drawing);
  }
  drawing = null;
  redraw();
});

// Text tool: drag a rectangular region, then type into a transparent textarea that fills
// it. The region (hence the wrap width) can be adjusted by dragging the textarea's resize
// handle. Font size tracks the current width; the on-screen size accounts for the canvas
// being scaled to fit. Enter inserts a newline; Ctrl/Cmd+Enter or clicking away commits;
// Esc cancels.
function openTextBox(bx: number, by: number, bw: number, bh: number, size: number, color: string): void {
  const cRect = canvas.getBoundingClientRect();
  const wRect = canvasWrap.getBoundingClientRect();
  const scale = canvas.width ? cRect.width / canvas.width : 1;
  textInput.style.left = cRect.left - wRect.left + bx * scale + 'px';
  textInput.style.top = cRect.top - wRect.top + by * scale + 'px';
  textInput.style.width = bw * scale + 'px';
  textInput.style.height = bh * scale + 'px';
  textInput.style.fontSize = size * scale + 'px';
  textInput.style.color = color;
  textInput.style.display = 'block';
  textInput.value = '';
  pendingTextOp = { tool: 'text', color, size, x: bx, y: by, w: bw };
  setTimeout(() => textInput.focus(), 0);
}

function commitTextIfAny(): void {
  if (textInput.style.display !== 'none' && textInput.value.trim() && pendingTextOp) {
    // Honor any manual resize: derive the wrap width from the textarea's current width.
    const scale = canvas.width ? canvas.getBoundingClientRect().width / canvas.width : 1;
    const w = scale ? textInput.offsetWidth / scale : pendingTextOp.w;
    ops.push({ ...pendingTextOp, w, text: textInput.value.replace(/\n+$/, '') });
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
  } else if (op.tool === 'numrect') {
    drawNumRect(op);
  } else if (op.tool === 'arrow') {
    drawArrow(op);
  } else if (op.tool === 'pen') {
    drawPen(op);
  } else if (op.tool === 'mosaic') {
    drawMosaic(op);
  } else if (op.tool === 'textbox') {
    // In-progress region preview (never committed).
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  } else if (op.tool === 'text') {
    const size = op.size || 20;
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, size / 8);
    const lineHeight = size * 1.2;
    wrapText(op.text || '', op.w).forEach((line, i) => {
      const ly = (op.y ?? 0) + i * lineHeight;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(line, op.x ?? 0, ly);
      ctx.fillStyle = op.color;
      ctx.fillText(line, op.x ?? 0, ly);
    });
  }
  ctx.restore();
}

/**
 * Wrap text to a maximum width (canvas pixels), honoring explicit newlines. Long single
 * tokens (e.g. CJK runs) are broken per character. Assumes ctx.font is already set.
 */
function wrapText(text: string, maxW?: number): string[] {
  const paragraphs = text.split('\n');
  if (!maxW || maxW <= 0) return paragraphs;
  const out: string[] = [];
  for (const para of paragraphs) {
    if (para === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const token of para.split(/(\s+)/)) {
      if (line === '') line = token;
      else if (ctx.measureText(line + token).width <= maxW) line += token;
      else {
        out.push(line.replace(/\s+$/, ''));
        line = token.replace(/^\s+/, '');
      }
      while (ctx.measureText(line).width > maxW && line.length > 1) {
        let i = line.length;
        while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line);
  }
  return out;
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

/** Draw a rectangle with a numbered, white-outlined circular badge at its top-left corner. */
function drawNumRect(op: Op): void {
  const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
  const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
  ctx.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));

  const r = Math.max(11, (op.width || 4) * 2.4);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = op.color;
  ctx.fill();
  ctx.lineWidth = Math.max(2, r / 6);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(op.num ?? '?'), x, y + r * 0.04);
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
