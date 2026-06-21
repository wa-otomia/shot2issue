// Editor page (also the main selection surface): renders the staged screenshot on a
// canvas, lets the user pick a workspace/type, annotate, fill in a title/description, and
// submit through the workspace's provider.
//
// The screenshot comes from chrome.storage.local, written by the service worker when
// the toolbar icon was clicked (or the keyboard shortcut was used). Images can also be
// added directly here by pasting from the clipboard (Ctrl+V or the Paste button).

import {
  getConfig,
  getPendingShots,
  setPendingShots,
  clearPendingShots,
  rememberSelection,
  getAiAuth,
  patchAiAuth,
  accountFor,
  makeAttachmentId,
} from './lib/storage.js';
import { setLanguage, localizeDom, t } from './lib/i18n.js';
import { getProvider } from './lib/providers/index.js';
import { generateTitle, transcribeAudio, generateComplaint } from './lib/ai.js';
import type { Config, Workspace, Op, Attachment, PendingShots, IssueResult } from './lib/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Workspace backend kind; workspaces created before this field default to GitHub. */
const wsKind = (ws: Workspace): string => ws.kind || 'github';
/** Human-readable label for a workspace option, tagged with its backend. */
function wsLabel(ws: Workspace): string {
  const provider = getProvider(wsKind(ws));
  const base = ws.name || provider.describe(ws) || wsKind(ws);
  return `${base} (${provider.label})`;
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
  copy: $('copy'),
  paste: $('paste') as HTMLButtonElement,
  workspace: $('workspace') as HTMLSelectElement,
  type: $('type') as HTMLSelectElement,
  title: $('title') as HTMLInputElement,
  aiModel: $('aiModel') as HTMLSelectElement,
  aiTitle: $('aiTitle') as HTMLButtonElement,
  complaint: $('complaint') as HTMLButtonElement,
  complaintModal: $('complaintModal'),
  complaintClose: $('complaintClose') as HTMLButtonElement,
  complaintText: $('complaintText') as HTMLTextAreaElement,
  complaintRecord: $('complaintRecord') as HTMLButtonElement,
  complaintClear: $('complaintClear') as HTMLButtonElement,
  complaintGenerate: $('complaintGenerate') as HTMLButtonElement,
  complaintStatus: $('complaintStatus'),
  body: $('body') as HTMLTextAreaElement,
  submit: $('submit') as HTMLButtonElement,
  submitNoImage: $('submitNoImage') as HTMLButtonElement,
  status: $('status'),
  result: $('result'),
  loginState: $('loginState'),
  openOptions: $('openOptions'),
  thumbStrip: $('thumbStrip'),
};

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- State ----
let config!: Config;
let shots: PendingShots | null = null; // the staged envelope (metadata + editorTabId)
let attachments: Attachment[] = []; // ordered screenshots, each with its own ops
let activeIndex = 0; // which attachment is on the canvas
const baseImage = new Image(); // the active screenshot (used for redraw and mosaic sampling)
let ops: Op[] = []; // alias of attachments[activeIndex].ops (a reference, reassigned on switch)
let currentTool = 'rect';
let drawing: Op | null = null; // in-progress drag op
let pendingTextOp: Op | null = null; // op being entered via the floating text input
let titleDirty = false; // true once the user edits the title (stop auto-filling the default)

/** The attachment currently on the canvas. */
function active(): Attachment | undefined {
  return attachments[activeIndex];
}
/** The primary (first) attachment — used for the issue's title/body template context. */
function primary(): Attachment | undefined {
  return attachments[0];
}
/** Persist the in-memory attachments back to local storage (fire-and-forget). */
function persist(): void {
  if (!shots) return;
  shots = { ...shots, attachments };
  setPendingShots(shots).catch((e) => {
    // The in-memory edit still works and can be submitted; it just may not survive a reload.
    console.warn('Could not persist staged screenshots:', e);
  });
}

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

  void refreshAiButton(); // enable the AI-title button only when the assistant is connected

  shots = await getPendingShots();
  attachments = shots ? shots.attachments.slice() : [];

  // Selects + listeners are set up regardless, so a later capture (appended live) works.
  if (!config.workspaces.length) setStatus(t('statusNeedWorkspace'), 'error');
  populateSelects();
  setupDefaults();
  watchForAppends();

  // Capture failed (e.g. a restricted page): the worker stages an error to show here.
  if (shots && shots.error && !attachments.length) {
    els.canvasEmpty.textContent = shots.error;
    els.canvasEmpty.classList.remove('hidden');
    canvas.classList.add('hidden');
    setStatus(shots.error, 'error');
    disableSubmit(true);
    void refreshLoginHint();
    return;
  }
  if (!attachments.length) {
    els.canvasEmpty.classList.remove('hidden');
    canvas.classList.add('hidden');
    setStatus(t('statusNoShot'), 'info');
    disableSubmit(true);
    void refreshLoginHint();
    return;
  }

  activeIndex = 0;
  loadActive();
  renderThumbs();
  void refreshLoginHint();
}

/** Load the active attachment onto the canvas and point `ops` at its op list. */
function loadActive(): void {
  const a = active();
  if (!a) return;
  ops = a.ops;
  els.canvasEmpty.classList.add('hidden');
  canvas.classList.remove('hidden');
  disableSubmit(false);
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    redraw();
  };
  baseImage.onerror = () => setStatus(t('statusImageLoadFailed'), 'error');
  baseImage.src = a.dataUrl;
}

/** Switch the canvas to a different attachment, saving the current one's ops first. */
function selectAttachment(i: number): void {
  if (i < 0 || i >= attachments.length) return;
  commitTextIfAny();
  persist();
  activeIndex = i;
  loadActive();
  renderThumbs();
}

/** Remove an attachment; pick a neighbor (or show the empty state if none remain). */
function deleteAttachment(i: number): void {
  commitTextIfAny();
  attachments.splice(i, 1);
  if (activeIndex >= attachments.length) activeIndex = Math.max(0, attachments.length - 1);
  persist();
  if (!attachments.length) {
    // No screenshots left: blank the editing area.
    if (canvas.width) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.classList.add('hidden');
    els.canvasEmpty.textContent = t('statusNoShot');
    els.canvasEmpty.classList.remove('hidden');
    disableSubmit(true);
    renderThumbs();
    return;
  }
  loadActive();
  renderThumbs();
}

/** Render the thumbnail strip (one tile per attachment, with a delete button). */
function renderThumbs(): void {
  els.thumbStrip.innerHTML = '';
  els.thumbStrip.classList.toggle('hidden', attachments.length === 0);
  attachments.forEach((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'thumb' + (i === activeIndex ? ' active' : '');
    tile.title = a.pageTitle || '';
    const img = document.createElement('img');
    img.src = a.dataUrl;
    img.alt = '';
    tile.appendChild(img);
    const del = document.createElement('button');
    del.className = 'thumb-del';
    del.textContent = '✕';
    del.title = t('attDelete');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAttachment(i);
    });
    tile.appendChild(del);
    tile.addEventListener('click', () => selectAttachment(i));
    els.thumbStrip.appendChild(tile);
  });
  if (attachments.length) {
    const hint = document.createElement('div');
    hint.className = 'thumb-hint';
    hint.textContent = t('attAddHint');
    els.thumbStrip.appendChild(hint);
  }
}

/** Live-append screenshots captured while this editor is open (background writes them). */
function watchForAppends(): void {
  chrome.storage.local.onChanged.addListener((changes) => {
    const c = changes['pendingShots'];
    if (!c || !c.newValue) return;
    const incoming = c.newValue as PendingShots;
    const known = new Set(attachments.map((a) => a.id));
    const added = incoming.attachments.filter((a) => a.id && a.dataUrl && !known.has(a.id));
    if (!added.length) return;
    commitTextIfAny();
    attachments.push(...added);
    if (!shots) shots = incoming;
    activeIndex = attachments.length - 1; // jump to the newly added screenshot
    loadActive();
    renderThumbs();
  });
}

function populateSelects(): void {
  els.workspace.innerHTML = '';
  for (const ws of config.workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = wsLabel(ws);
    els.workspace.appendChild(opt);
  }
  const wsId = (shots && shots.workspaceId) || config.lastWorkspaceId;
  if (wsId && config.workspaces.some((w) => w.id === wsId)) els.workspace.value = wsId;

  els.type.innerHTML = '';
  for (const ty of config.types) {
    const opt = document.createElement('option');
    opt.value = ty;
    opt.textContent = ty;
    els.type.appendChild(opt);
  }
  if (shots && shots.type && config.types.includes(shots.type)) els.type.value = shots.type;
}

/** Substitute {pageTitle}, {pageUrl}, {type} (unknown placeholders are left as-is). */
function applyTemplate(tpl: string): string {
  const p = primary();
  const vars: Record<string, string> = {
    pageTitle: (p && p.pageTitle) || '',
    pageUrl: (p && p.pageUrl) || '',
    type: els.type.value || '',
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function defaultTitle(): string {
  return applyTemplate(config.titleTemplate).replace(/[ \t]+/g, ' ').trim();
}

function setupDefaults(): void {
  els.title.value = defaultTitle();
  els.body.value = applyTemplate(config.bodyTemplate);
}

els.title.addEventListener('input', () => {
  titleDirty = true;
});

/** Enable the AI buttons (and show the model picker) only when the assistant is connected. */
async function refreshAiButton(): Promise<void> {
  const auth = await getAiAuth();
  els.aiTitle.disabled = !auth;
  els.aiTitle.title = auth ? t('aiTitleTitle') : t('aiTitleNeedConnect');
  els.complaint.disabled = !auth;
  els.complaint.title = auth ? t('complaintTitle') : t('aiTitleNeedConnect');
  // Model picker: same options as Settings, kept in sync (auth.model is shared).
  const models = auth && auth.models && auth.models.length ? auth.models : [];
  if (models.length) {
    els.aiModel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      els.aiModel.appendChild(opt);
    }
    els.aiModel.value = auth?.model && models.includes(auth.model) ? auth.model : models[0];
    els.aiModel.classList.remove('hidden');
  } else {
    els.aiModel.classList.add('hidden');
  }
}

els.aiModel.addEventListener('change', () => {
  void patchAiAuth({ model: els.aiModel.value });
});

// ---- Complaint modal: type or dictate → transcribe → AI writes title + body ----
// The modal content is NOT cleared between opens (within the page), and Generate can be run
// repeatedly.
let recording = false;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];

function complaintModalOpen(): boolean {
  return !els.complaintModal.classList.contains('hidden');
}
function openComplaintModal(): void {
  els.complaintModal.classList.remove('hidden');
  clampPanelIntoView(els.complaintModal); // a prior drag may have left it off the (now smaller) viewport
  setComplaintStatus('');
  setTimeout(() => els.complaintText.focus(), 0);
}

/** Keep a fixed-position panel inside the viewport (only if it was dragged to absolute left/top). */
function clampPanelIntoView(panel: HTMLElement): void {
  if (!panel.style.left && !panel.style.top) return; // still using the default bottom-right anchor
  const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
  panel.style.left = `${Math.max(0, Math.min(parseFloat(panel.style.left) || 0, maxX))}px`;
  panel.style.top = `${Math.max(0, Math.min(parseFloat(panel.style.top) || 0, maxY))}px`;
}
function closeComplaintModal(): void {
  if (recording) stopRecording();
  els.complaintModal.classList.add('hidden');
}
function setComplaintStatus(text: string, cls: 'info' | 'error' | 'ok' = 'info'): void {
  els.complaintStatus.className = cls;
  els.complaintStatus.textContent = text;
}

els.complaint.addEventListener('click', () => openComplaintModal()); // content persists
els.complaintClose.addEventListener('click', () => closeComplaintModal());
els.complaintModal.addEventListener('click', (e) => {
  if (e.target === els.complaintModal) closeComplaintModal(); // click on the backdrop
});

// Let the floating dictation panel be dragged by its header (resizing is CSS `resize: both`).
function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const nx = Math.max(0, Math.min(originX + (e.clientX - startX), window.innerWidth - panel.offsetWidth));
    const ny = Math.max(0, Math.min(originY + (e.clientY - startY), window.innerHeight - panel.offsetHeight));
    panel.style.left = `${nx}px`;
    panel.style.top = `${ny}px`;
  };
  const onUp = (): void => {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  handle.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.modal-close')) return; // don't drag from the ✕
    const r = panel.getBoundingClientRect();
    panel.style.left = `${r.left}px`; // switch from bottom-right anchoring to absolute left/top
    panel.style.top = `${r.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    originX = r.left;
    originY = r.top;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
const complaintHead = els.complaintModal.querySelector('.modal-head') as HTMLElement | null;
if (complaintHead) makeDraggable(els.complaintModal, complaintHead);
// Re-clamp when the user resizes the panel (CSS resize), so a grown box can't push its
// buttons past the viewport edge after it was dragged toward a corner.
const complaintInner = els.complaintModal.querySelector('.modal') as HTMLElement | null;
if (complaintInner && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => clampPanelIntoView(els.complaintModal)).observe(complaintInner);
}

// Record → transcribe → append into the text box (you can dictate several times + edit).
els.complaintRecord.addEventListener('click', async () => {
  if (recording) {
    stopRecording();
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setComplaintStatus(t('complaintMicDenied'), 'error');
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((tr) => tr.stop());
    void transcribeIntoBox(new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'audio/webm' }));
  };
  mediaRecorder.start();
  recording = true;
  els.complaintRecord.classList.add('recording');
  els.complaintRecord.textContent = t('complaintRecordStop');
});

function stopRecording(): void {
  recording = false;
  els.complaintRecord.classList.remove('recording');
  els.complaintRecord.textContent = t('complaintRecordStart');
  try {
    mediaRecorder?.stop();
  } catch {
    /* ignore */
  }
}

/** Insert text at the textarea's caret (replacing any selection); keeps existing content. */
function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const sep = before && !/\s$/.test(before) ? ' ' : ''; // space off the previous word if needed
  ta.value = before + sep + text + after;
  const pos = (before + sep + text).length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
}

async function transcribeIntoBox(blob: Blob): Promise<void> {
  els.complaintRecord.disabled = true;
  try {
    setComplaintStatus(t('complaintTranscribing'));
    const transcript = (await transcribeAudio(blob)).trim();
    if (transcript) insertAtCursor(els.complaintText, transcript); // at the caret, never clearing
    setComplaintStatus('');
  } catch (e) {
    setComplaintStatus(t('complaintFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  } finally {
    els.complaintRecord.disabled = false;
  }
}

els.complaintClear.addEventListener('click', () => {
  els.complaintText.value = '';
  els.complaintText.focus();
});

// Generate the issue title + body from the text box content + the screenshots. Repeatable.
els.complaintGenerate.addEventListener('click', async () => {
  const text = els.complaintText.value.trim();
  if (!text) {
    setComplaintStatus(t('complaintNeedText'), 'error');
    return;
  }
  els.complaintGenerate.disabled = true;
  try {
    setComplaintStatus(t('complaintGenerating'));
    const images = await aiImages();
    const p = primary();
    const { title, body } = await generateComplaint(
      {
        transcript: text,
        type: els.type.value,
        pageTitle: p?.pageTitle,
        pageUrl: p?.pageUrl,
        images: images.length ? images : undefined,
      },
      { instructions: config.aiComplaintPrompt || t('aiComplaintPromptDefault') }
    );
    if (title) {
      els.title.value = title;
      titleDirty = true;
    }
    if (body) els.body.value = body;
    closeComplaintModal(); // done — close (content is kept for next time)
    showToast(t('complaintDone'));
  } catch (e) {
    setComplaintStatus(t('complaintFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  } finally {
    els.complaintGenerate.disabled = false;
  }
});

els.aiTitle.addEventListener('click', async () => {
  if (!els.body.value.trim()) {
    setStatus(t('aiTitleNeedBody'), 'error');
    return;
  }
  els.aiTitle.disabled = true;
  const label = els.aiTitle.textContent;
  els.aiTitle.textContent = t('aiTitleGenerating');
  try {
    commitTextIfAny(); // flush any in-progress text so it appears in the screenshots
    const images = await aiImages(); // all attachments, annotated + downscaled
    const p = primary();
    const { title } = await generateTitle(
      {
        type: els.type.value,
        pageTitle: p?.pageTitle,
        pageUrl: p?.pageUrl,
        body: els.body.value,
        images: images.length ? images : undefined,
      },
      { instructions: config.aiTitlePrompt || t('aiTitlePromptDefault') }
    );
    els.title.value = title;
    titleDirty = true;
    setStatus('', 'info');
  } catch (e) {
    setStatus(t('aiTitleFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  } finally {
    els.aiTitle.textContent = label || t('aiTitle');
    els.aiTitle.disabled = false;
  }
});

els.type.addEventListener('change', () => {
  void rememberSelection({ type: els.type.value });
  if (!titleDirty) els.title.value = defaultTitle();
});
els.workspace.addEventListener('change', () => {
  void rememberSelection({ workspaceId: els.workspace.value });
  void refreshLoginHint();
});

/** Overlay the bound Account's baseUrl/token for account-based workspaces. */
function mergedWorkspace(ws: Workspace): Workspace {
  const acct = accountFor(config, ws);
  return acct ? { ...ws, baseUrl: acct.baseUrl, token: acct.token } : ws;
}

async function refreshLoginHint(): Promise<void> {
  const raw = selectedWorkspace();
  if (!raw) {
    els.loginState.textContent = '';
    return;
  }
  const ws = mergedWorkspace(raw);
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
  persist();
});
els.clear.addEventListener('click', () => {
  commitTextIfAny();
  ops.length = 0; // clear in place so attachments[activeIndex].ops stays the same array
  redraw();
  persist();
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
  if (e.key === 'Escape' && complaintModalOpen()) {
    closeComplaintModal();
    return;
  }
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
    persist();
  }
  // Ctrl/Cmd+C copies the current screenshot — unless the user is selecting text or typing.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    if ((window.getSelection()?.toString() || '').trim()) return;
    if (!attachments.length) return;
    e.preventDefault();
    void copyCanvas();
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
  let added = false;
  if (drawing.tool === 'pen') {
    if ((drawing.points?.length ?? 0) > 1) {
      ops.push(drawing);
      added = true;
    }
  } else {
    const moved = Math.hypot((drawing.x1 ?? 0) - (drawing.x0 ?? 0), (drawing.y1 ?? 0) - (drawing.y0 ?? 0)) > 3;
    if (moved) {
      ops.push(drawing);
      added = true;
    }
  }
  drawing = null;
  redraw();
  if (added) persist();
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
  let added = false;
  if (textInput.style.display !== 'none' && textInput.value.trim() && pendingTextOp) {
    // Honor any manual resize: derive the wrap width from the textarea's current width.
    const scale = canvas.width ? canvas.getBoundingClientRect().width / canvas.width : 1;
    const w = scale ? textInput.offsetWidth / scale : pendingTextOp.w;
    ops.push({ ...pendingTextOp, w, text: textInput.value.replace(/\n+$/, '') });
    added = true;
  }
  textInput.style.display = 'none';
  textInput.blur(); // drop focus so a later Esc closes the editor instead of being swallowed
  pendingTextOp = null;
  redraw();
  if (added) persist();
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

type Img = HTMLImageElement | HTMLCanvasElement;

/** Redraw the visible canvas: active base image + its committed ops + in-progress preview. */
function redraw(): void {
  if (!canvas.width) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  for (const op of ops) drawOne(ctx, baseImage, op);
  if (drawing) drawOne(ctx, baseImage, drawing);
}

/** Render a base image plus a list of ops onto an arbitrary context (used for export). */
function renderOps(c: CanvasRenderingContext2D, base: Img, w: number, h: number, opsList: Op[]): void {
  c.clearRect(0, 0, w, h);
  c.drawImage(base, 0, 0, w, h);
  for (const op of opsList) drawOne(c, base, op);
}

function drawOne(c: CanvasRenderingContext2D, base: Img, op: Op): void {
  c.save();
  c.strokeStyle = op.color;
  c.fillStyle = op.color;
  c.lineWidth = op.width || 4;
  c.lineJoin = 'round';
  c.lineCap = 'round';

  if (op.tool === 'rect') {
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    c.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  } else if (op.tool === 'numrect') {
    drawNumRect(c, op);
  } else if (op.tool === 'arrow') {
    drawArrow(c, op);
  } else if (op.tool === 'pen') {
    drawPen(c, op);
  } else if (op.tool === 'mosaic') {
    drawMosaic(c, base, op);
  } else if (op.tool === 'textbox') {
    // In-progress region preview (never committed).
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    c.setLineDash([6, 4]);
    c.lineWidth = 1.5;
    c.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  } else if (op.tool === 'text') {
    const size = op.size || 20;
    c.font = `bold ${size}px system-ui, sans-serif`;
    c.textBaseline = 'top';
    c.lineWidth = Math.max(2, size / 8);
    const lineHeight = size * 1.2;
    wrapText(c, op.text || '', op.w).forEach((line, i) => {
      const ly = (op.y ?? 0) + i * lineHeight;
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.strokeText(line, op.x ?? 0, ly);
      c.fillStyle = op.color;
      c.fillText(line, op.x ?? 0, ly);
    });
  }
  c.restore();
}

/**
 * Wrap text to a maximum width (canvas pixels), honoring explicit newlines. Long single
 * tokens (e.g. CJK runs) are broken per character. Assumes c.font is already set.
 */
function wrapText(c: CanvasRenderingContext2D, text: string, maxW?: number): string[] {
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
      else if (c.measureText(line + token).width <= maxW) line += token;
      else {
        out.push(line.replace(/\s+$/, ''));
        line = token.replace(/^\s+/, '');
      }
      while (c.measureText(line).width > maxW && line.length > 1) {
        let i = line.length;
        while (i > 1 && c.measureText(line.slice(0, i)).width > maxW) i--;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line);
  }
  return out;
}

/** Stroke a freehand pen path. */
function drawPen(c: CanvasRenderingContext2D, op: Op): void {
  const pts = op.points || [];
  if (pts.length < 2) return;
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  c.stroke();
}

/** Draw a rectangle with a numbered, white-outlined circular badge at its top-left corner. */
function drawNumRect(c: CanvasRenderingContext2D, op: Op): void {
  const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
  const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
  c.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));

  const r = Math.max(11, (op.width || 4) * 2.4);
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = op.color;
  c.fill();
  c.lineWidth = Math.max(2, r / 6);
  c.strokeStyle = '#ffffff';
  c.stroke();

  c.fillStyle = '#ffffff';
  c.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(op.num ?? '?'), x, y + r * 0.04);
  c.textAlign = 'start'; // reset for subsequent text ops
}

function drawArrow(c: CanvasRenderingContext2D, op: Op): void {
  const x0 = op.x0 ?? 0;
  const y0 = op.y0 ?? 0;
  const x1 = op.x1 ?? 0;
  const y1 = op.y1 ?? 0;
  const head = Math.max(10, (op.width || 4) * 3);
  const angle = Math.atan2(y1 - y0, x1 - x0);
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
  c.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
  c.closePath();
  c.fill();
}

/**
 * Mosaic / redaction: sample the region from the base image, downscale it, then draw it
 * back enlarged with smoothing off to produce hard pixel blocks. Sampling the base image
 * (not the current canvas) keeps redaction of the original content stable.
 */
function drawMosaic(c: CanvasRenderingContext2D, base: Img, op: Op): void {
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
  tctx.drawImage(base, x, y, w, h, 0, 0, sw, sh);
  c.save();
  c.imageSmoothingEnabled = false;
  c.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  c.restore();
}

// ============================================================================
// 3) Export / download
// ============================================================================
function canvasToDataUrl(): string {
  return canvas.toDataURL('image/png');
}

/** Render one attachment (base image + its ops) to a PNG data URL, off-screen. */
function renderAttachmentToDataUrl(att: Attachment): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      off.width = img.naturalWidth;
      off.height = img.naturalHeight;
      const c = off.getContext('2d');
      if (!c) {
        resolve(att.dataUrl);
        return;
      }
      renderOps(c, img, off.width, off.height, att.ops);
      resolve(off.toDataURL('image/png'));
    };
    img.onerror = () => resolve(att.dataUrl); // fall back to the raw screenshot
    img.src = att.dataUrl;
  });
}

/** Downscale a data URL to a JPEG (max longest side) for sending to the AI as context. */
function downscaleDataUrl(src: string, max = 1536): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(img.naturalWidth * scale));
      off.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = off.getContext('2d');
      if (!c) {
        resolve(src);
        return;
      }
      c.drawImage(img, 0, 0, off.width, off.height);
      resolve(off.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

/** Render every attachment (with annotations) and downscale each for AI visual context. */
async function aiImages(): Promise<string[]> {
  const rendered = await buildSubmitImages();
  const out: string[] = [];
  for (const r of rendered) out.push(await downscaleDataUrl(r.dataUrl));
  return out;
}

els.download.addEventListener('click', () => {
  commitTextIfAny();
  const a = document.createElement('a');
  a.href = canvasToDataUrl();
  a.download = `shot-${Date.now()}.png`;
  a.click();
});

/** Copy the current canvas (with annotations) to the clipboard. */
async function copyCanvas(): Promise<void> {
  if (!attachments.length) return;
  commitTextIfAny();
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('no image');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast(t('copied'));
  } catch (e) {
    showToast(t('copyFailed', [e instanceof Error ? e.message : String(e)]));
  }
}

els.copy.addEventListener('click', () => void copyCanvas());

// ---- Clipboard paste: add an image from the clipboard as a new attachment ----
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** Add an image (data URL) as a new attachment, select it, and persist. */
async function addImageAttachment(dataUrl: string, title = t('clipboardImage')): Promise<void> {
  commitTextIfAny();
  const att: Attachment = {
    id: makeAttachmentId(),
    dataUrl,
    pageUrl: '',
    pageTitle: title,
    ops: [],
    createdAt: Date.now(),
  };
  attachments.push(att);
  if (!shots) {
    // Editor opened empty (manual paste, no capture): start an envelope and record this tab
    // so the background's onRemoved/onStartup cleanup clears the staged image when it closes.
    shots = { attachments: [] };
    try {
      const me = await chrome.tabs.getCurrent();
      if (me && me.id != null) shots.editorTabId = me.id;
    } catch {
      /* getCurrent unavailable */
    }
  } else {
    shots = { ...shots, error: undefined }; // a successful paste clears any prior capture error
  }
  activeIndex = attachments.length - 1;
  loadActive();
  renderThumbs();
  disableSubmit(false);
  persist();
  showToast(t('pasteAdded'));
}

// Ctrl/Cmd+V (or right-click → Paste): if the clipboard holds an image, add it. Text paste
// into the title/description fields is untouched (those events carry no image item).
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of Array.from(items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      void blobToDataUrl(blob)
        .then((url) => addImageAttachment(url))
        .catch((err) => showToast(t('pasteFailed', [err instanceof Error ? err.message : String(err)])));
      return;
    }
  }
});

// Explicit "Paste" button (uses the async clipboard API; needs the clipboardRead permission).
async function pasteFromClipboard(): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((ty) => ty.startsWith('image/'));
      if (type) {
        await addImageAttachment(await blobToDataUrl(await it.getType(type)));
        return;
      }
    }
    showToast(t('pasteNoImage'));
  } catch (e) {
    showToast(t('pasteFailed', [e instanceof Error ? e.message : String(e)]));
  }
}
els.paste.addEventListener('click', () => void pasteFromClipboard());

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

/** Validate preconditions. Returns the merged { ws } (account creds overlaid) or throws. */
function preflight(): { ws: Workspace } {
  const raw = selectedWorkspace();
  if (!raw) throw new Error(t('errSelectWorkspace'));
  const ws = mergedWorkspace(raw);
  const errKey = getProvider(wsKind(ws)).validate(ws);
  if (errKey) throw new Error(t(errKey));
  if (!els.title.value.trim()) throw new Error(t('errTitleEmpty'));
  return { ws };
}

/** Render every attachment to a {dataUrl, filename} for submission, in order. */
async function buildSubmitImages(): Promise<Array<{ dataUrl: string; filename: string }>> {
  const stamp = Date.now();
  const out: Array<{ dataUrl: string; filename: string }> = [];
  for (let i = 0; i < attachments.length; i++) {
    const dataUrl = await renderAttachmentToDataUrl(attachments[i]);
    out.push({ dataUrl, filename: `shot-${i + 1}-${stamp}.png` });
  }
  return out;
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
    const images = withImage ? await buildSubmitImages() : [];
    const acct = accountFor(config, ws);
    const issue: IssueResult = await getProvider(wsKind(ws)).submit(ws, {
      title: els.title.value.trim(),
      body: els.body.value,
      images,
      withImage: withImage && images.length > 0,
      dataUrl: images[0]?.dataUrl || '',
      filename: images[0]?.filename || `shot-${Date.now()}.png`,
      account: acct ? { id: acct.id, kind: acct.kind, baseUrl: acct.baseUrl, token: acct.token } : undefined,
      t,
      busy: (key: string) => setStatusBusy(t(key)),
    });

    const num = issue.number || '';
    showResult(issue);
    await clearPendingShots();

    // Optionally return to the captured tab and close this editor tab.
    if (config.closeAfterSubmit && shots && shots.sourceTabId != null) {
      setStatus(num ? t('statusReturning', [num]) : t('statusCreatedNoNumber'), 'ok');
      await sleep(900);
      try {
        await chrome.tabs.update(shots.sourceTabId, { active: true });
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
