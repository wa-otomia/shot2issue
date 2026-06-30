// Editor page (also the main selection surface): renders the staged screenshot on a
// canvas, lets the user pick a workspace/type, annotate, fill in a title/description, and
// submit through the workspace's provider.
//
// The screenshot comes from chrome.storage.local, written by the service worker when
// the toolbar icon was clicked (or the keyboard shortcut was used). Images can also be
// added directly here by pasting from the clipboard (Ctrl+V or the Paste button).

import {
  getConfig,
  patchConfig,
  getPendingShots,
  setPendingShots,
  clearPendingShots,
  rememberSelection,
  getAiAuth,
  patchAiAuth,
  accountFor,
  makeAttachmentId,
  getEditorPrefs,
  patchEditorPrefs,
} from './lib/storage.js';
import { setLanguage, localizeDom, t } from './lib/i18n.js';
import { getProvider } from './lib/providers/index.js';
import { generateTitle, transcribeAudio, generateComplaint, partialComplaintFields } from './lib/ai.js';
import type { Config, Workspace, Op, Attachment, PendingShots, IssueResult, EditorPrefs } from './lib/types.js';

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
  strokeColor: $('strokeColor') as HTMLInputElement,
  strokeWidth: $('strokeWidth') as HTMLInputElement,
  width: $('width') as HTMLInputElement,
  fontSize: $('fontSize') as HTMLInputElement,
  widthCtl: $('widthCtl'),
  fontSizeCtl: $('fontSizeCtl'),
  cropBar: $('cropBar'),
  cropApply: $('cropApply') as HTMLButtonElement,
  cropCancel: $('cropCancel') as HTMLButtonElement,
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
  aiReasoning: $('aiReasoning') as HTMLSelectElement,
  autoDictate: $('autoDictate') as HTMLInputElement,
  aiBubble: $('aiBubble'),
  aiBubbleStatus: $('aiBubbleStatus'),
  aiBubbleThink: $('aiBubbleThink'),
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

// Interacting with anything in the right column commits any pending canvas edit first (flush an
// in-progress text box, deselect the active annotation) so nothing is left half-edited.
$('formCol').addEventListener(
  'mousedown',
  () => {
    commitTextIfAny();
    deselect();
  },
  true
);

// ---- State ----
let config!: Config;
let shots: PendingShots | null = null; // the staged envelope (metadata + editorTabId)
let attachments: Attachment[] = []; // ordered screenshots, each with its own ops
let activeIndex = 0; // which attachment is on the canvas
const baseImage = new Image(); // the active screenshot (used for redraw and mosaic sampling)
let ops: Op[] = []; // alias of attachments[activeIndex].ops (a reference, reassigned on switch)
let currentTool = 'rect';
// Tools whose selection is remembered/restorable. 'crop' is intentionally excluded — it's a
// transient mode, not a drawing tool. Also used to reject stale/garbage persisted values.
const DRAWING_TOOLS = ['rect', 'numrect', 'arrow', 'pen', 'text', 'mosaic'];
let drawing: Op | null = null; // in-progress drag op
let pendingTextOp: Op | null = null; // op being entered via the floating text input
let titleDirty = false; // true once the user edits the title (stop auto-filling the default)

// Remembered tool settings (color, outline, thickness, font size); loaded on init.
let prefs: EditorPrefs = { color: '#ff3b30', strokeColor: '#ffffff', strokeWidth: 3, width: 4, fontSize: 28, tool: 'rect' };

// Select-and-manipulate: the last drawn op stays "selected" (movable + reshapeable) until the
// user clicks elsewhere on the canvas. Pen commits immediately and is never selected.
let selected: Op | null = null;
type DragMode = 'move' | 'resize' | 'crop-move' | 'crop-resize' | null;
let dragMode: DragMode = null;
let dragHandle = ''; // which resize handle: n/s/e/w/ne/nw/se/sw, or 'p0'/'p1' for arrow ends
let dragStart = { x: 0, y: 0 }; // pointer position at drag start (canvas px)
let dragOrig: Op | null = null; // snapshot of the op's geometry at drag start
// Crop tool: a pending crop rectangle (canvas px), applied on confirm.
let cropRect: { x: number; y: number; w: number; h: number } | null = null;
let cropOrig: { x: number; y: number; w: number; h: number } | null = null;

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

  // Load remembered tool settings (color, outline, thickness, font size) into the toolbar.
  prefs = await getEditorPrefs();
  els.color.value = prefs.color;
  els.strokeColor.value = prefs.strokeColor;
  els.strokeWidth.value = String(prefs.strokeWidth);
  els.width.value = String(prefs.width);
  els.fontSize.value = String(prefs.fontSize);
  els.autoDictate.checked = !!config.autoDictate;
  applyToolControls();
  // Restore the last-used drawing tool (the whitelist rejects 'crop' and any stale value).
  const startTool = DRAWING_TOOLS.includes(prefs.tool) ? prefs.tool : 'rect';
  if (startTool !== currentTool) setTool(startTool, false); // value already came from storage — don't rewrite it
  // Move toolbar button titles to data-tip so they render as styled hover tooltips.
  document.querySelectorAll('#toolbar .tool[title], #toolbar .act[title]').forEach((el) => {
    const tip = el.getAttribute('title');
    if (tip) {
      (el as HTMLElement).dataset.tip = tip;
      el.removeAttribute('title');
    }
  });

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
  selected = null; // selection/crop are per-image and transient
  cropRect = null;
  cropOrig = null;
  els.cropBar.classList.add('hidden');
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
    els.aiReasoning.value = config.aiReasoning || 'off';
    els.aiReasoning.classList.remove('hidden');
  } else {
    els.aiModel.classList.add('hidden');
    els.aiReasoning.classList.add('hidden');
  }
}

els.aiModel.addEventListener('change', () => {
  void patchAiAuth({ model: els.aiModel.value });
});
els.aiReasoning.addEventListener('change', () => {
  config.aiReasoning = els.aiReasoning.value; // reasoning effort is shared with Settings
  void patchConfig({ aiReasoning: config.aiReasoning });
});
els.autoDictate.addEventListener('change', () => {
  config.autoDictate = els.autoDictate.checked; // remembered: auto-start dictation on open
  void patchConfig({ autoDictate: config.autoDictate });
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
  updateComplaintGenerate();
  setTimeout(() => els.complaintText.focus(), 0);
  if (config.autoDictate && !recording) void startDictation(); // auto-start recording when enabled
}

/** Disable the Generate button while the dictation box is empty (nothing to generate from). */
function updateComplaintGenerate(): void {
  els.complaintGenerate.disabled = !els.complaintText.value.trim();
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

els.complaint.addEventListener('click', () => {
  if (complaintAbort) {
    complaintAbort.abort(); // generating → this button is the Stop control
    return;
  }
  openComplaintModal(); // content persists between opens
});
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
els.complaintRecord.addEventListener('click', () => {
  if (recording) stopRecording();
  else void startDictation();
});

async function startDictation(): Promise<void> {
  if (recording) return;
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
}

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
  openBubble(els.complaintRecord, 'aiStateTranscribing'); // bubble points at the voice-input button
  try {
    setComplaintStatus('');
    const prompt = (config.aiVocabulary || []).join(', '); // dictionary terms bias recognition
    const transcript = (await transcribeAudio(blob, { prompt, language: config.dictationLang })).trim();
    if (transcript) insertAtCursor(els.complaintText, transcript); // at the caret, never clearing
    updateComplaintGenerate();
    bubbleDone();
  } catch (e) {
    bubbleFail(t('complaintFailed', [errMsg(e)]));
  } finally {
    els.complaintRecord.disabled = false;
  }
}

els.complaintClear.addEventListener('click', () => {
  els.complaintText.value = '';
  updateComplaintGenerate();
  els.complaintText.focus();
});
els.complaintText.addEventListener('input', updateComplaintGenerate);

// Generate the issue title + body from the text box content + the screenshots. Repeatable.
// ---- Streaming AI generation: a status bubble that points at the active button ----
let titleAbort: AbortController | null = null;
let complaintAbort: AbortController | null = null;
let aiBusy = false; // true while a generation is streaming (locks the canvas + toolbar)
let bubbleAnchor: HTMLElement | null = null;
let bubbleCloseTimer: number | undefined;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const wasAborted = (c: AbortController | null, e: unknown): boolean =>
  !!c?.signal.aborted || (e instanceof Error && e.name === 'AbortError');

/** Position the bubble above (or below) its anchor button, arrow pointing at it. */
function positionBubble(): void {
  if (!bubbleAnchor || els.aiBubble.classList.contains('hidden')) return;
  const r = bubbleAnchor.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // anchor is hidden (e.g. modal closed) — keep last position
  const b = els.aiBubble.getBoundingClientRect();
  const gap = 10;
  let top: number;
  let pointDown: boolean;
  if (r.top - b.height - gap >= 8) {
    top = r.top - b.height - gap;
    pointDown = true; // bubble above → arrow on its bottom edge
  } else {
    top = r.bottom + gap;
    pointDown = false;
  }
  let left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - b.width - 8));
  els.aiBubble.style.left = `${left}px`;
  els.aiBubble.style.top = `${top}px`;
  els.aiBubble.classList.toggle('point-down', pointDown);
  els.aiBubble.classList.toggle('point-up', !pointDown);
  els.aiBubble.style.setProperty('--arrow-x', `${r.left + r.width / 2 - left}px`);
}
function openBubble(anchor: HTMLElement, statusKey: string): void {
  window.clearTimeout(bubbleCloseTimer);
  bubbleAnchor = anchor;
  els.aiBubble.classList.remove('hidden', 'done', 'error', 'closing');
  els.aiBubbleStatus.textContent = t(statusKey);
  els.aiBubbleThink.textContent = '';
  positionBubble();
}
function bubbleStatus(statusKey: string): void {
  els.aiBubbleStatus.textContent = t(statusKey);
}
function bubbleThink(full: string): void {
  if (els.aiBubbleStatus.textContent === t('aiStateRequesting')) bubbleStatus('aiThinking');
  els.aiBubbleThink.textContent = full;
  els.aiBubbleThink.scrollTop = els.aiBubbleThink.scrollHeight;
  positionBubble();
}
function bubbleDone(): void {
  els.aiBubble.classList.add('done');
  els.aiBubbleStatus.textContent = t('aiStateDone');
  bubbleCloseTimer = window.setTimeout(closeBubble, 1500);
}
function bubbleFail(msg: string): void {
  els.aiBubble.classList.add('error');
  els.aiBubbleStatus.textContent = msg;
  bubbleCloseTimer = window.setTimeout(closeBubble, 3000);
}
function closeBubble(): void {
  els.aiBubble.classList.add('closing');
  bubbleCloseTimer = window.setTimeout(() => {
    els.aiBubble.classList.add('hidden');
    els.aiBubble.classList.remove('closing', 'done', 'error');
    bubbleAnchor = null;
  }, 250);
}
window.addEventListener('resize', positionBubble);
window.addEventListener('scroll', positionBubble, true);

/** Disable the rest of the UI during a generation so nothing conflicts (the Stop button stays live). */
function setAiBusy(busy: boolean, except: HTMLElement | null): void {
  aiBusy = busy;
  const list: Array<HTMLButtonElement | HTMLSelectElement> = [
    els.submit, els.submitNoImage, els.aiModel, els.aiReasoning, els.workspace, els.type,
    els.aiTitle, els.complaint, els.complaintRecord, els.complaintClear,
  ];
  for (const el of list) el.disabled = busy && el !== except;
  $('toolbar').classList.toggle('disabled', busy);
}

els.complaintGenerate.addEventListener('click', () => {
  const text = els.complaintText.value.trim();
  if (!text) {
    setComplaintStatus(t('complaintNeedText'), 'error');
    return;
  }
  closeComplaintModal(); // reveal the form so the output streams visibly into the textarea
  void runComplaint(text);
});

/** Stream a dictation generation into the title + description, bubble pointing at the textarea. */
async function runComplaint(text: string): Promise<void> {
  complaintAbort = new AbortController();
  const label = els.complaint.textContent; // the main "Smart dictation" button becomes Stop
  els.complaint.textContent = t('aiStop');
  els.complaint.classList.add('ai-busy');
  setAiBusy(true, els.complaint);
  openBubble(els.body, 'aiStateRequesting'); // points at the description textarea (the output target)
  try {
    commitTextIfAny();
    const images = await aiImages();
    const p = primary();
    const { title, body } = await generateComplaint(
      { transcript: text, type: els.type.value, pageTitle: p?.pageTitle, pageUrl: p?.pageUrl, images: images.length ? images : undefined },
      {
        instructions: config.aiComplaintPrompt || t('aiComplaintPromptDefault'),
        signal: complaintAbort.signal,
        reasoningEffort: config.aiReasoning,
        onReasoning: (_d, full) => bubbleThink(full),
        onText: (_d, full) => {
          // The structured JSON streams in; show each field live in its own control.
          const r = partialComplaintFields(full);
          if (r.title != null) {
            els.title.value = r.title.slice(0, 200);
            titleDirty = true;
          }
          if (r.body != null) els.body.value = r.body;
          bubbleStatus('aiStateWriting');
        },
      }
    );
    if (title) {
      els.title.value = title;
      titleDirty = true;
    }
    if (body) els.body.value = body;
    bubbleDone();
    showToast(t('complaintDone'));
  } catch (e) {
    if (wasAborted(complaintAbort, e)) {
      bubbleStatus('aiStopped');
      closeBubble();
    } else {
      bubbleFail(t('complaintFailed', [errMsg(e)]));
    }
  } finally {
    els.complaint.textContent = label || t('complaint');
    els.complaint.classList.remove('ai-busy');
    complaintAbort = null;
    setAiBusy(false, null);
  }
}

els.aiTitle.addEventListener('click', async () => {
  if (titleAbort) {
    titleAbort.abort();
    return;
  }
  if (!els.body.value.trim()) {
    setStatus(t('aiTitleNeedBody'), 'error');
    return;
  }
  titleAbort = new AbortController();
  const label = els.aiTitle.textContent;
  const titleBefore = els.title.value;
  const dirtyBefore = titleDirty;
  els.aiTitle.textContent = t('aiStop');
  els.aiTitle.classList.add('ai-busy');
  setAiBusy(true, els.aiTitle);
  openBubble(els.title, 'aiStateRequesting'); // bubble points at the title field (the output target)
  els.title.classList.add('streaming');
  try {
    commitTextIfAny(); // flush any in-progress text so it appears in the screenshots
    const images = await aiImages(); // all attachments, annotated + downscaled
    const p = primary();
    const { title } = await generateTitle(
      { type: els.type.value, pageTitle: p?.pageTitle, pageUrl: p?.pageUrl, body: els.body.value, images: images.length ? images : undefined },
      {
        instructions: config.aiTitlePrompt || t('aiTitlePromptDefault'),
        signal: titleAbort.signal,
        reasoningEffort: config.aiReasoning,
        onText: (_d, full) => {
          els.title.value = (full.split('\n')[0] || '').slice(0, 120); // stream the title in, live
          titleDirty = true;
          bubbleStatus('aiStateWriting');
        },
        onReasoning: (_d, full) => bubbleThink(full),
      }
    );
    els.title.value = title;
    titleDirty = true;
    bubbleDone();
    setStatus('', 'info');
  } catch (e) {
    if (wasAborted(titleAbort, e)) {
      els.title.value = titleBefore;
      titleDirty = dirtyBefore;
      bubbleStatus('aiStopped');
      closeBubble();
    } else {
      bubbleFail(t('aiTitleFailed', [errMsg(e)]));
    }
  } finally {
    els.aiTitle.textContent = label || t('aiTitle');
    els.aiTitle.classList.remove('ai-busy');
    els.title.classList.remove('streaming');
    titleAbort = null;
    setAiBusy(false, null);
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

/** Show the font-size control for the text tool, the thickness control otherwise. */
function applyToolControls(): void {
  const isText = currentTool === 'text';
  els.widthCtl.classList.toggle('hidden', isText);
  els.fontSizeCtl.classList.toggle('hidden', !isText);
}

function setTool(tool: string, persist = true): void {
  if (tool === currentTool) return;
  commitTextIfAny();
  if (currentTool === 'crop') cancelCrop(); // leaving the crop tool discards a pending region
  deselect();
  currentTool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tool === tool));
  applyToolControls();
  // Remember the user's chosen drawing tool across sessions. Skip 'crop' (transient) and
  // internal resets (persist=false, e.g. crop-apply returning to 'rect') so neither clobbers it.
  if (persist && tool !== 'crop') {
    prefs.tool = tool;
    void patchEditorPrefs({ tool });
  }
}

$('toolbar').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.tool') as HTMLElement | null;
  if (btn && btn.dataset.tool) setTool(btn.dataset.tool);
});

// Color / outline / thickness / font size: remembered across sessions, and applied live to
// the currently selected annotation (so you can recolor / resize it after drawing).
els.color.addEventListener('input', () => {
  prefs.color = els.color.value;
  void patchEditorPrefs({ color: prefs.color });
  if (selected) {
    selected.color = prefs.color;
    redraw();
    persist();
  }
});
els.strokeColor.addEventListener('input', () => {
  prefs.strokeColor = els.strokeColor.value;
  void patchEditorPrefs({ strokeColor: prefs.strokeColor });
  if (selected) {
    selected.strokeColor = prefs.strokeColor;
    redraw();
    persist();
  }
});
els.strokeWidth.addEventListener('input', () => {
  prefs.strokeWidth = Number(els.strokeWidth.value); // 0 = no outline
  void patchEditorPrefs({ strokeWidth: prefs.strokeWidth });
  if (selected) {
    selected.strokeWidth = prefs.strokeWidth;
    redraw();
    persist();
  }
});
els.width.addEventListener('input', () => {
  prefs.width = Number(els.width.value);
  void patchEditorPrefs({ width: prefs.width });
  if (selected && selected.tool !== 'text') {
    selected.width = prefs.width;
    redraw();
    persist();
  }
});
els.fontSize.addEventListener('input', () => {
  prefs.fontSize = Number(els.fontSize.value);
  void patchEditorPrefs({ fontSize: prefs.fontSize });
  if (pendingTextOp) {
    // Live-resize the text currently being typed.
    pendingTextOp.size = prefs.fontSize;
    const scale = canvas.width ? canvas.getBoundingClientRect().width / canvas.width : 1;
    textInput.style.fontSize = prefs.fontSize * scale + 'px';
  }
  if (selected && selected.tool === 'text') {
    selected.size = prefs.fontSize;
    redraw();
    persist();
  }
});

els.undo.addEventListener('click', () => {
  commitTextIfAny();
  deselect();
  ops.pop();
  redraw();
  persist();
});
els.clear.addEventListener('click', () => {
  commitTextIfAny();
  deselect();
  ops.length = 0; // clear in place so attachments[activeIndex].ops stays the same array
  redraw();
  persist();
});
els.cropApply.addEventListener('click', () => applyCrop());
els.cropCancel.addEventListener('click', () => cancelCrop());

// Page-level shortcuts:
//   Esc (twice) → return to the captured tab and close this editor (the first press shows a toast)
//   Ctrl/Cmd+Z  → undo the last annotation (native undo still works inside text fields)

/** Re-activate the tab the screenshot was captured from (and focus its window), if still open. */
async function focusSourceTab(): Promise<void> {
  if (!shots || shots.sourceTabId == null) return;
  try {
    const tab = await chrome.tabs.update(shots.sourceTabId, { active: true });
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* the original tab may have been closed */
  }
}

async function closeEditorTab(): Promise<void> {
  await focusSourceTab(); // return the user to where they were before closing the editor
  try {
    const me = await chrome.tabs.getCurrent();
    if (me && me.id != null) await chrome.tabs.remove(me.id);
  } catch {
    /* ignore */
  }
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
    if (cropRect) {
      cancelCrop(); // first Esc cancels a pending crop
      return;
    }
    if (selected) {
      deselect(); // then it deselects the active annotation
      return;
    }
    if (escArmed) {
      window.clearTimeout(escTimer);
      escArmed = false;
      void closeEditorTab();
    } else {
      escArmed = true;
      showToast(t('escAgainToClose'));
      escTimer = window.setTimeout(() => {
        escArmed = false;
      }, 2000);
    }
    return;
  }
  if (currentTool === 'crop' && cropRect && e.key === 'Enter') {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // don't crop while typing
    e.preventDefault();
    applyCrop();
    return;
  }
  if (selected && e.key === 'Enter') {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // don't fire while typing
    e.preventDefault();
    deselect(); // commit/fix the selected annotation
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // leave text undo alone
    e.preventDefault();
    commitTextIfAny();
    deselect();
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

// ---- Selection / manipulation geometry -------------------------------------
type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
const HANDLE = 9; // resize-handle hit/half-size, in screen px
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(v, b));
/** Canvas pixels per screen pixel (the canvas element is CSS-scaled to fit). */
function scaleFactor(): number {
  const r = canvas.getBoundingClientRect();
  return r.width ? canvas.width / r.width : 1;
}
function cloneOp(op: Op): Op {
  return JSON.parse(JSON.stringify(op)) as Op;
}
function deselect(): void {
  if (!selected) return;
  selected = null;
  redraw();
}
/** Which ops can be selected and manipulated after drawing (pen commits immediately). */
function isSelectable(tool: string): boolean {
  return tool === 'rect' || tool === 'numrect' || tool === 'arrow' || tool === 'mosaic' || tool === 'text';
}

/** Measured bounding box (canvas px) of any selectable op. */
function bboxOf(op: Op): Rect {
  if (op.tool === 'text') {
    const size = op.size || 20;
    ctx.save();
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    const lines = wrapText(ctx, op.text || '', op.w);
    let maxw = 10;
    for (const l of lines) maxw = Math.max(maxw, ctx.measureText(l).width);
    ctx.restore();
    return { x: op.x ?? 0, y: op.y ?? 0, w: op.w || maxw, h: Math.max(size * 1.2, lines.length * size * 1.2) };
  }
  const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
  const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
  return { x, y, w: Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), h: Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)) };
}
function boxHandles(b: Rect): Array<{ name: string; x: number; y: number }> {
  const { x, y, w, h } = b;
  return [
    { name: 'nw', x, y }, { name: 'n', x: x + w / 2, y }, { name: 'ne', x: x + w, y },
    { name: 'e', x: x + w, y: y + h / 2 }, { name: 'se', x: x + w, y: y + h }, { name: 's', x: x + w / 2, y: y + h },
    { name: 'sw', x, y: y + h }, { name: 'w', x, y: y + h / 2 },
  ];
}
function handlesOf(op: Op): Array<{ name: string; x: number; y: number }> {
  if (op.tool === 'arrow') return [{ name: 'p0', x: op.x0 ?? 0, y: op.y0 ?? 0 }, { name: 'p1', x: op.x1 ?? 0, y: op.y1 ?? 0 }];
  const b = bboxOf(op);
  if (op.tool === 'text') return [{ name: 'w', x: b.x, y: b.y + b.h / 2 }, { name: 'e', x: b.x + b.w, y: b.y + b.h / 2 }];
  return boxHandles(b);
}
function handleAt(op: Op, p: Pt): string {
  const tol = HANDLE * scaleFactor();
  for (const h of handlesOf(op)) if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return h.name;
  return '';
}
function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function pointInOp(op: Op, p: Pt): boolean {
  if (op.tool === 'arrow') return distToSeg(p, { x: op.x0 ?? 0, y: op.y0 ?? 0 }, { x: op.x1 ?? 0, y: op.y1 ?? 0 }) <= 8 * scaleFactor();
  const b = bboxOf(op), m = 3;
  return p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
}
function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
function moveOpBy(op: Op, orig: Op, dx: number, dy: number): void {
  if (op.tool === 'text') {
    op.x = (orig.x ?? 0) + dx;
    op.y = (orig.y ?? 0) + dy;
    return;
  }
  op.x0 = (orig.x0 ?? 0) + dx;
  op.y0 = (orig.y0 ?? 0) + dy;
  op.x1 = (orig.x1 ?? 0) + dx;
  op.y1 = (orig.y1 ?? 0) + dy;
}
function resizeOp(op: Op, orig: Op, handle: string, p: Pt): void {
  if (op.tool === 'arrow') {
    if (handle === 'p0') { op.x0 = p.x; op.y0 = p.y; } else { op.x1 = p.x; op.y1 = p.y; }
    return;
  }
  if (op.tool === 'text') {
    const right = (orig.x ?? 0) + (orig.w ?? 0);
    if (handle === 'e') op.w = Math.max(24, p.x - (op.x ?? 0));
    else if (handle === 'w') { const nx = Math.min(p.x, right - 24); op.x = nx; op.w = right - nx; }
    return;
  }
  let l = Math.min(orig.x0 ?? 0, orig.x1 ?? 0), t = Math.min(orig.y0 ?? 0, orig.y1 ?? 0);
  let r = Math.max(orig.x0 ?? 0, orig.x1 ?? 0), b = Math.max(orig.y0 ?? 0, orig.y1 ?? 0);
  if (handle.includes('w')) l = p.x;
  if (handle.includes('e')) r = p.x;
  if (handle.includes('n')) t = p.y;
  if (handle.includes('s')) b = p.y;
  op.x0 = l; op.y0 = t; op.x1 = r; op.y1 = b;
}
/** After a box resize the corners may have crossed; normalize so x0<x1, y0<y1. */
function normalizeSelected(): void {
  const op = selected;
  if (!op || op.tool === 'arrow' || op.tool === 'text') return;
  const l = Math.min(op.x0 ?? 0, op.x1 ?? 0), r = Math.max(op.x0 ?? 0, op.x1 ?? 0);
  const t = Math.min(op.y0 ?? 0, op.y1 ?? 0), b = Math.max(op.y0 ?? 0, op.y1 ?? 0);
  op.x0 = l; op.y0 = t; op.x1 = r; op.y1 = b;
}

// ---- Crop ------------------------------------------------------------------
function cropHandles(): Array<{ name: string; x: number; y: number }> {
  return cropRect ? boxHandles(cropRect) : [];
}
function cropHandleAt(p: Pt): string {
  const tol = HANDLE * scaleFactor();
  for (const h of cropHandles()) if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return h.name;
  return '';
}
function resizeCrop(handle: string, p: Pt): void {
  if (!cropOrig || !cropRect) return;
  let l = cropOrig.x, t = cropOrig.y, r = cropOrig.x + cropOrig.w, b = cropOrig.y + cropOrig.h;
  if (handle.includes('w')) l = clamp(p.x, 0, r - 10);
  if (handle.includes('e')) r = clamp(p.x, l + 10, canvas.width);
  if (handle.includes('n')) t = clamp(p.y, 0, b - 10);
  if (handle.includes('s')) b = clamp(p.y, t + 10, canvas.height);
  cropRect.x = l; cropRect.y = t; cropRect.w = r - l; cropRect.h = b - t;
}
function cancelCrop(): void {
  cropRect = null;
  cropOrig = null;
  els.cropBar.classList.add('hidden');
  redraw();
}
function offsetOp(op: Op, dx: number, dy: number): Op {
  const o = cloneOp(op);
  if (o.x0 != null) o.x0 += dx;
  if (o.x1 != null) o.x1 += dx;
  if (o.y0 != null) o.y0 += dy;
  if (o.y1 != null) o.y1 += dy;
  if (o.x != null) o.x += dx;
  if (o.y != null) o.y += dy;
  if (o.points) o.points = o.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
  return o;
}
function opIntersects(op: Op, w: number, h: number): boolean {
  const b = bboxOf(op);
  return b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0;
}
/** Crop the active attachment to cropRect: new base image + ops offset (and clipped). */
function applyCrop(): void {
  if (!cropRect || !canvas.width) return;
  const x = clamp(Math.round(cropRect.x), 0, canvas.width - 1);
  const y = clamp(Math.round(cropRect.y), 0, canvas.height - 1);
  const w = clamp(Math.round(cropRect.w), 1, canvas.width - x);
  const h = clamp(Math.round(cropRect.h), 1, canvas.height - y);
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const c = off.getContext('2d');
  const a = active();
  if (!c || !a) return;
  c.drawImage(baseImage, x, y, w, h, 0, 0, w, h); // base image only; ops are kept editable
  const dataUrl = off.toDataURL('image/png');
  a.ops = a.ops.map((op) => offsetOp(op, -x, -y)).filter((op) => opIntersects(op, w, h));
  a.dataUrl = dataUrl;
  ops = a.ops;
  cropRect = null;
  cropOrig = null;
  selected = null;
  els.cropBar.classList.add('hidden');
  setTool('rect', false); // internal reset out of crop mode — must NOT overwrite the remembered tool
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    redraw();
  };
  baseImage.src = dataUrl;
  renderThumbs();
  persist();
}

// ---- Pointer interaction ---------------------------------------------------
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // right/middle click must not draw
  if (aiBusy) return; // don't edit the canvas while a generation is streaming
  if (!baseImage.src) return;
  const p = toCanvasXY(e);

  // Crop tool: manipulate the pending crop rectangle, or drag a new one.
  if (currentTool === 'crop') {
    if (cropRect) {
      const h = cropHandleAt(p);
      if (h) { dragMode = 'crop-resize'; dragHandle = h; cropOrig = { ...cropRect }; dragStart = p; return; }
      if (pointInRect(p, cropRect)) { dragMode = 'crop-move'; cropOrig = { ...cropRect }; dragStart = p; return; }
    }
    cropRect = null;
    els.cropBar.classList.add('hidden');
    drawing = { tool: 'crop', color: '', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    return;
  }

  // A selected op: drag a handle to reshape, the body to move, or click off to fix it.
  if (selected) {
    const h = handleAt(selected, p);
    if (h) { dragMode = 'resize'; dragHandle = h; dragOrig = cloneOp(selected); dragStart = p; return; }
    if (pointInOp(selected, p)) { dragMode = 'move'; dragOrig = cloneOp(selected); dragStart = p; return; }
    deselect();
  }

  if (currentTool === 'text') {
    commitTextIfAny();
    drawing = { tool: 'textbox', color: prefs.color, strokeColor: prefs.strokeColor, strokeWidth: prefs.strokeWidth, width: prefs.width, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    return;
  }
  if (currentTool === 'pen') {
    drawing = { tool: 'pen', color: prefs.color, strokeColor: prefs.strokeColor, strokeWidth: prefs.strokeWidth, width: prefs.width, points: [{ x: p.x, y: p.y }] };
    return;
  }
  drawing = { tool: currentTool, color: prefs.color, strokeColor: prefs.strokeColor, strokeWidth: prefs.strokeWidth, width: prefs.width, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  // Next badge = max existing + 1 (not count + 1), so a crop that drops a middle box won't collide.
  if (currentTool === 'numrect') drawing.num = Math.max(0, ...ops.filter((o) => o.tool === 'numrect').map((o) => o.num ?? 0)) + 1;
});

canvas.addEventListener('mousemove', (e) => {
  const p = toCanvasXY(e);
  if (dragMode === 'move' && dragOrig && selected) { moveOpBy(selected, dragOrig, p.x - dragStart.x, p.y - dragStart.y); redraw(); return; }
  if (dragMode === 'resize' && dragOrig && selected) { resizeOp(selected, dragOrig, dragHandle, p); redraw(); return; }
  if (dragMode === 'crop-move' && cropOrig && cropRect) {
    cropRect.x = clamp(cropOrig.x + (p.x - dragStart.x), 0, canvas.width - cropRect.w);
    cropRect.y = clamp(cropOrig.y + (p.y - dragStart.y), 0, canvas.height - cropRect.h);
    redraw();
    positionCropBar();
    return;
  }
  if (dragMode === 'crop-resize') { resizeCrop(dragHandle, p); redraw(); positionCropBar(); return; }
  if (!drawing) {
    updateHoverCursor(p); // change the cursor over handles / movable bodies
    return;
  }
  if (drawing.tool === 'pen') drawing.points?.push({ x: p.x, y: p.y });
  else { drawing.x1 = p.x; drawing.y1 = p.y; }
  redraw();
});

/** Resize cursor for a handle name (move for endpoints/body). */
function cursorForHandle(h: string): string {
  if (h === 'p0' || h === 'p1') return 'move';
  if (h === 'nw' || h === 'se') return 'nwse-resize';
  if (h === 'ne' || h === 'sw') return 'nesw-resize';
  if (h === 'n' || h === 's') return 'ns-resize';
  return 'ew-resize';
}
/** Update the canvas cursor based on what's under the pointer (handle / body / draw). */
function updateHoverCursor(p: Pt): void {
  let cur = 'crosshair';
  if (currentTool === 'crop' && cropRect) {
    const h = cropHandleAt(p);
    if (h) cur = cursorForHandle(h);
    else if (pointInRect(p, cropRect)) cur = 'move';
  } else if (selected) {
    const h = handleAt(selected, p);
    if (h) cur = cursorForHandle(h);
    else if (pointInOp(selected, p)) cur = 'move';
  }
  canvas.style.cursor = cur;
}

/** Position the floating crop-confirm buttons inside the crop box's bottom-right corner. */
function positionCropBar(): void {
  if (!cropRect) {
    els.cropBar.classList.add('hidden');
    return;
  }
  els.cropBar.classList.remove('hidden');
  const s = canvas.getBoundingClientRect();
  const wrap = canvasWrap.getBoundingClientRect();
  const scale = canvas.width ? s.width / canvas.width : 1;
  const x = s.left - wrap.left + (cropRect.x + cropRect.w) * scale;
  const y = s.top - wrap.top + (cropRect.y + cropRect.h) * scale;
  els.cropBar.style.left = `${x - 6}px`;
  els.cropBar.style.top = `${y - 38 >= 2 ? y - 38 : y + 6}px`; // inside the box, or just below if no room
  els.cropBar.style.transform = 'translateX(-100%)'; // right-align to the crop box edge
}
window.addEventListener('resize', positionCropBar);

window.addEventListener('mouseup', () => {
  if (dragMode) {
    if (dragMode === 'move' || dragMode === 'resize') { normalizeSelected(); persist(); }
    dragMode = null;
    dragOrig = null;
    cropOrig = null;
    redraw();
    return;
  }
  if (!drawing) return;
  const d = drawing;
  drawing = null;

  if (d.tool === 'crop') {
    const x = Math.min(d.x0 ?? 0, d.x1 ?? 0), y = Math.min(d.y0 ?? 0, d.y1 ?? 0);
    const w = Math.abs((d.x1 ?? 0) - (d.x0 ?? 0)), h = Math.abs((d.y1 ?? 0) - (d.y0 ?? 0));
    if (w > 8 && h > 8) { cropRect = { x, y, w, h }; positionCropBar(); }
    redraw();
    return;
  }
  if (d.tool === 'textbox') {
    const bx = Math.min(d.x0 ?? 0, d.x1 ?? 0), by = Math.min(d.y0 ?? 0, d.y1 ?? 0);
    let bw = Math.abs((d.x1 ?? 0) - (d.x0 ?? 0)), bh = Math.abs((d.y1 ?? 0) - (d.y0 ?? 0));
    const size = prefs.fontSize;
    if (bw < 8 || bh < 8) { bw = 240; bh = Math.round(size * 1.6); }
    redraw();
    openTextBox(bx, by, bw, bh, size, d.color, d.strokeColor || prefs.strokeColor);
    return;
  }
  let added = false;
  if (d.tool === 'pen') {
    if ((d.points?.length ?? 0) > 1) { ops.push(d); added = true; }
  } else {
    const moved = Math.hypot((d.x1 ?? 0) - (d.x0 ?? 0), (d.y1 ?? 0) - (d.y0 ?? 0)) > 3;
    if (moved) { ops.push(d); added = true; }
  }
  if (added) {
    selected = isSelectable(d.tool) ? d : null; // a freshly drawn op stays selected (pen excepted)
    persist();
  }
  redraw();
});

// Text tool: drag a rectangular region, then type into a transparent textarea that fills
// it. The region (hence the wrap width) can be adjusted by dragging the textarea's resize
// handle. Font size tracks the current width; the on-screen size accounts for the canvas
// being scaled to fit. Enter inserts a newline; Ctrl/Cmd+Enter or clicking away commits;
// Esc cancels.
function openTextBox(bx: number, by: number, bw: number, bh: number, size: number, color: string, strokeColor: string): void {
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
  pendingTextOp = { tool: 'text', color, strokeColor, strokeWidth: prefs.strokeWidth, size, x: bx, y: by, w: bw };
  setTimeout(() => textInput.focus(), 0);
}

function commitTextIfAny(): void {
  let committed: Op | null = null;
  if (textInput.style.display !== 'none' && textInput.value.trim() && pendingTextOp) {
    // Honor any manual resize: derive the wrap width from the textarea's current width.
    const scale = canvas.width ? canvas.getBoundingClientRect().width / canvas.width : 1;
    const w = scale ? textInput.offsetWidth / scale : pendingTextOp.w;
    committed = { ...pendingTextOp, w, text: textInput.value.replace(/\n+$/, '') };
    ops.push(committed);
  }
  textInput.style.display = 'none';
  textInput.blur(); // drop focus so a later Esc closes the editor instead of being swallowed
  pendingTextOp = null;
  if (committed) selected = committed; // the just-typed text becomes selectable/movable
  redraw();
  if (committed) persist();
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
  if (drawing && drawing.tool !== 'crop') drawOne(ctx, baseImage, drawing);
  if (selected) drawSelectionChrome(selected);
  const liveCrop = cropRect || (drawing && drawing.tool === 'crop' ? cropRectFromDrawing(drawing) : null);
  if (liveCrop) drawCropOverlay(liveCrop);
}

function cropRectFromDrawing(d: Op): Rect {
  const x = Math.min(d.x0 ?? 0, d.x1 ?? 0), y = Math.min(d.y0 ?? 0, d.y1 ?? 0);
  return { x, y, w: Math.abs((d.x1 ?? 0) - (d.x0 ?? 0)), h: Math.abs((d.y1 ?? 0) - (d.y0 ?? 0)) };
}

/** Dashed bounding box + square handles around the selected op (sizes constant on screen). */
function drawSelectionChrome(op: Op): void {
  const s = scaleFactor();
  ctx.save();
  ctx.strokeStyle = '#1f6feb';
  ctx.lineWidth = 1.5 * s;
  ctx.setLineDash([5 * s, 4 * s]);
  if (op.tool === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(op.x0 ?? 0, op.y0 ?? 0);
    ctx.lineTo(op.x1 ?? 0, op.y1 ?? 0);
    ctx.stroke();
  } else {
    const b = bboxOf(op);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.setLineDash([]);
  const r = HANDLE * s * 0.7;
  for (const h of handlesOf(op)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.rect(h.x - r, h.y - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Darken everything outside the crop rect and draw its frame + handles. */
function drawCropOverlay(r: Rect): void {
  const s = scaleFactor();
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, canvas.width, r.y);
  ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - (r.y + r.h));
  ctx.fillRect(0, r.y, r.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, canvas.width - (r.x + r.w), r.h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * s;
  ctx.setLineDash([6 * s, 4 * s]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  const hr = HANDLE * s * 0.7;
  for (const h of boxHandles(r)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.rect(h.x - hr, h.y - hr, hr * 2, hr * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Render a base image plus a list of ops onto an arbitrary context (used for export). */
function renderOps(c: CanvasRenderingContext2D, base: Img, w: number, h: number, opsList: Op[]): void {
  c.clearRect(0, 0, w, h);
  c.drawImage(base, 0, 0, w, h);
  for (const op of opsList) drawOne(c, base, op);
}

/** Halo line width: the colored line width plus the outline thickness on each side. */
function haloWidth(width: number, sw: number): number {
  return width + 2 * sw;
}
/** Stroke a rectangle with a contrasting outline (halo) under the main color; sw=0 → no outline. */
function strokeRectHalo(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, stroke: string, width: number, sw: number): void {
  c.lineJoin = 'round';
  if (sw > 0) {
    c.strokeStyle = stroke;
    c.lineWidth = haloWidth(width, sw);
    c.strokeRect(x, y, w, h);
  }
  c.strokeStyle = color;
  c.lineWidth = width;
  c.strokeRect(x, y, w, h);
}

/** Outline thickness for an op (older ops without the field default to 3; 0 = no outline). */
function outlineWidth(op: Op): number {
  return op.strokeWidth ?? 3;
}

function drawOne(c: CanvasRenderingContext2D, base: Img, op: Op): void {
  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const stroke = op.strokeColor || '#ffffff'; // contrasting halo color
  const sw = outlineWidth(op);
  const width = op.width || 4;

  if (op.tool === 'rect') {
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    strokeRectHalo(c, x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)), op.color, stroke, width, sw);
  } else if (op.tool === 'numrect') {
    drawNumRect(c, op, stroke, sw);
  } else if (op.tool === 'arrow') {
    drawArrow(c, op, stroke, sw);
  } else if (op.tool === 'pen') {
    drawPen(c, op, stroke, sw);
  } else if (op.tool === 'mosaic') {
    drawMosaic(c, base, op);
  } else if (op.tool === 'textbox' || op.tool === 'crop') {
    // In-progress region preview (never committed).
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    c.strokeStyle = op.color || '#1f6feb';
    c.setLineDash([6, 4]);
    c.lineWidth = 1.5;
    c.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  } else if (op.tool === 'text') {
    const size = op.size || 20;
    c.font = `bold ${size}px system-ui, sans-serif`;
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    const lineHeight = size * 1.2;
    wrapText(c, op.text || '', op.w).forEach((line, i) => {
      const ly = (op.y ?? 0) + i * lineHeight;
      if (sw > 0) {
        c.lineWidth = Math.max(1, sw * 2);
        c.strokeStyle = stroke;
        c.strokeText(line, op.x ?? 0, ly);
      }
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

/** Stroke a freehand pen path with a contrasting halo under the main color (sw=0 → no halo). */
function drawPen(c: CanvasRenderingContext2D, op: Op, stroke: string, sw: number): void {
  const pts = op.points || [];
  if (pts.length < 2) return;
  const width = op.width || 4;
  const trace = (): void => {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  };
  if (sw > 0) {
    c.strokeStyle = stroke;
    c.lineWidth = haloWidth(width, sw);
    trace();
    c.stroke();
  }
  c.strokeStyle = op.color;
  c.lineWidth = width;
  trace();
  c.stroke();
}

/** Draw a rectangle with a numbered circular badge (outlined in the contrasting color). */
function drawNumRect(c: CanvasRenderingContext2D, op: Op, stroke: string, sw: number): void {
  const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
  const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
  const width = op.width || 4;
  strokeRectHalo(c, x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)), op.color, stroke, width, sw);

  const r = Math.max(11, width * 2.4);
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = op.color;
  c.fill();
  c.lineWidth = Math.max(2, r / 6);
  c.strokeStyle = stroke;
  c.stroke();

  c.fillStyle = stroke;
  c.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(op.num ?? '?'), x, y + r * 0.04);
  c.textAlign = 'start'; // reset for subsequent text ops
}

function drawArrow(c: CanvasRenderingContext2D, op: Op, stroke: string, sw: number): void {
  const x0 = op.x0 ?? 0;
  const y0 = op.y0 ?? 0;
  const x1 = op.x1 ?? 0;
  const y1 = op.y1 ?? 0;
  const width = op.width || 4;
  const head = Math.max(10, width * 3);
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const shaft = (): void => {
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  };
  const headPath = (): void => {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
    c.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
    c.closePath();
  };
  // Halo first (shaft + head outline), then the colored arrow on top (sw=0 → no halo).
  if (sw > 0) {
    c.strokeStyle = stroke;
    c.lineWidth = haloWidth(width, sw);
    shaft();
    c.stroke();
    headPath();
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, sw * 2);
    c.stroke();
    c.fillStyle = stroke;
    c.fill();
  }
  c.strokeStyle = op.color;
  c.lineWidth = width;
  shaft();
  c.stroke();
  c.fillStyle = op.color;
  headPath();
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
  clearChrome(); // never bake the selection box / crop overlay into the exported PNG
  const a = document.createElement('a');
  a.href = canvasToDataUrl();
  a.download = `shot-${Date.now()}.png`;
  a.click();
});

/** Remove transient on-canvas UI (selection handles, crop overlay) and repaint a clean frame. */
function clearChrome(): void {
  if (cropRect) cancelCrop(); // also repaints
  deselect(); // repaints if something was selected
  redraw(); // ensure a clean frame even if nothing was selected/cropping
}

/** Copy the current canvas (with annotations) to the clipboard. */
async function copyCanvas(): Promise<void> {
  if (!attachments.length) return;
  commitTextIfAny();
  clearChrome();
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
      await focusSourceTab();
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
