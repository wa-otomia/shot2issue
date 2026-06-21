// Settings page: manage workspaces (any provider) and types, choose the UI language,
// behavior, and keyboard shortcut, and back up / restore the configuration. Everything is
// stored in chrome.storage.local.
//
// An in-memory draft is edited on the page and written to storage only on Save (the
// language change applies immediately so the UI re-localizes as you pick it).

import { getConfig, setConfig, makeId, getAiAuth, setAiAuth, patchAiAuth, clearAiAuth } from './lib/storage.js';
import { setLanguage, localizeDom, t, SUPPORTED_LANGS } from './lib/i18n.js';
import { PROVIDER_LIST, getProvider } from './lib/providers/index.js';
import {
  connectAuto,
  beginManualAuth,
  completeManualAuth,
  ensureAiPermissions,
  ensureFreshAuth,
  fetchModels,
  normalizeModel,
  DEFAULT_MODELS,
} from './lib/ai.js';
import type { Config, Workspace, AiAuth, AiQuota } from './lib/types.js';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const els = {
  workspaces: $('workspaces'),
  addWorkspace: $('addWorkspace'),
  typeChips: $('typeChips'),
  newType: $('newType') as HTMLInputElement,
  addType: $('addType'),
  lang: $('lang') as HTMLSelectElement,
  titleTemplate: $('titleTemplate') as HTMLInputElement,
  bodyTemplate: $('bodyTemplate') as HTMLTextAreaElement,
  closeAfterSubmit: $('closeAfterSubmit') as HTMLInputElement,
  shortcutEnabled: $('shortcutEnabled') as HTMLInputElement,
  configureShortcut: $('configureShortcut'),
  save: $('save'),
  status: $('status'),
  exportConfig: $('exportConfig'),
  importConfig: $('importConfig'),
  importFile: $('importFile') as HTMLInputElement,
  // AI assistant
  aiDisconnected: $('aiDisconnected'),
  aiConnect: $('aiConnect') as HTMLButtonElement,
  aiManualToggle: $('aiManualToggle'),
  aiManual: $('aiManual'),
  aiManualOpen: $('aiManualOpen') as HTMLButtonElement,
  aiPasted: $('aiPasted') as HTMLInputElement,
  aiManualComplete: $('aiManualComplete') as HTMLButtonElement,
  aiConnectedBox: $('aiConnectedBox'),
  aiAccount: $('aiAccount'),
  aiPlan: $('aiPlan'),
  aiModel: $('aiModel') as HTMLSelectElement,
  aiUsage: $('aiUsage'),
  aiRefresh: $('aiRefresh') as HTMLButtonElement,
  aiSignOut: $('aiSignOut') as HTMLButtonElement,
  aiStatus: $('aiStatus'),
  aiTitlePrompt: $('aiTitlePrompt') as HTMLTextAreaElement,
  aiPromptRestore: $('aiPromptRestore') as HTMLButtonElement,
};

let draft: Config;

const wsKind = (ws: Workspace): string => ws.kind || 'github';

function status(text: string, cls = ''): void {
  els.status.className = cls;
  els.status.textContent = text;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---- Workspaces ----
function renderWorkspaces(): void {
  els.workspaces.innerHTML = '';
  if (!draft.workspaces.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('noWorkspaces');
    els.workspaces.appendChild(p);
  }
  draft.workspaces.forEach((ws, idx) => {
    const kind = wsKind(ws);
    const provider = getProvider(kind);
    const card = document.createElement('div');
    card.className = 'ws-card';

    const targetOptions = PROVIDER_LIST.map(
      (p) => `<option value="${escapeAttr(p.id)}">${escapeAttr(p.label)}</option>`
    ).join('');

    const fieldHtml = provider.fields
      .map((f) => {
        const ph = f.placeholderKey ? t(f.placeholderKey) : f.placeholder || '';
        const type = f.type === 'password' ? 'password' : 'text';
        return `
        <div class="${f.full ? 'full' : ''}">
          <label>${t(f.labelKey)}</label>
          <input type="${type}" data-k="${escapeAttr(f.key)}" placeholder="${escapeAttr(ph)}" />
        </div>`;
      })
      .join('');

    const hintHtml = provider.hintKey
      ? `<div class="full"><p class="hint" style="margin:4px 0 0;">${t(provider.hintKey)}</p></div>`
      : '';

    card.innerHTML = `
      <div class="ws-grid">
        <div class="full">
          <label>${t('wsName')}</label>
          <input type="text" data-k="name" placeholder="${escapeAttr(t('wsNamePlaceholder'))}" />
        </div>
        <div class="full">
          <label>${t('wsTarget')}</label>
          <select data-k="kind" style="max-width:200px;">${targetOptions}</select>
        </div>
        ${fieldHtml}
        ${hintHtml}
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="danger" data-act="remove">${t('wsRemove')}</button>
      </div>
    `;

    (card.querySelector('[data-k="name"]') as HTMLInputElement).value = ws.name || '';
    (card.querySelector('[data-k="kind"]') as HTMLSelectElement).value = kind;
    for (const f of provider.fields) {
      const input = card.querySelector(`[data-k="${f.key}"]`) as HTMLInputElement | null;
      if (input) input.value = ws[f.key] || '';
    }

    card.querySelectorAll('[data-k]').forEach((node) => {
      const input = node as HTMLInputElement | HTMLSelectElement;
      const k = input.dataset.k as string;
      if (k === 'kind') {
        input.addEventListener('change', () => {
          draft.workspaces[idx].kind = input.value;
          renderWorkspaces(); // swap to the fields for the chosen target
        });
      } else {
        input.addEventListener('input', () => {
          draft.workspaces[idx][k] = input.value.trim();
        });
      }
    });
    (card.querySelector('[data-act="remove"]') as HTMLButtonElement).addEventListener('click', () => {
      draft.workspaces.splice(idx, 1);
      renderWorkspaces();
    });

    els.workspaces.appendChild(card);
  });
}

els.addWorkspace.addEventListener('click', () => {
  draft.workspaces.push({ id: makeId(), kind: 'github', name: '', owner: '', repo: '' });
  renderWorkspaces();
});

// ---- Types ----
function renderTypes(): void {
  els.typeChips.innerHTML = '';
  draft.types.forEach((ty, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const span = document.createElement('span');
    span.textContent = ty;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      draft.types.splice(idx, 1);
      renderTypes();
    });
    chip.appendChild(span);
    chip.appendChild(btn);
    els.typeChips.appendChild(chip);
  });
}

function addType(): void {
  const v = els.newType.value.trim();
  if (!v) return;
  if (!draft.types.includes(v)) draft.types.push(v);
  els.newType.value = '';
  renderTypes();
}
els.addType.addEventListener('click', addType);
els.newType.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addType();
  }
});

// ---- Language (applies immediately) ----
els.lang.addEventListener('change', () => {
  draft.lang = SUPPORTED_LANGS.includes(els.lang.value) ? els.lang.value : 'en';
  setLanguage(draft.lang);
  localizeDom(document);
  renderWorkspaces(); // re-render dynamically built content in the new language
  renderTypes();
  void renderAi();
  // If the prompt is not customized, show the new language's default.
  if (!draft.aiTitlePrompt) els.aiTitlePrompt.value = t('aiTitlePromptDefault');
});

// ---- Default templates ----
els.titleTemplate.addEventListener('input', () => {
  draft.titleTemplate = els.titleTemplate.value;
});
els.bodyTemplate.addEventListener('input', () => {
  draft.bodyTemplate = els.bodyTemplate.value;
});

// ---- AI assistant ----
function aiStatus(text: string, cls = ''): void {
  els.aiStatus.className = cls;
  els.aiStatus.textContent = text;
}

function renderUsage(q?: AiQuota): string {
  if (!q) return t('aiUsageUnknown');
  const parts: string[] = [];
  if (q.primaryUsedPercent != null) parts.push(`${t('aiUsage5h')}: ${q.primaryUsedPercent}%`);
  if (q.secondaryUsedPercent != null) parts.push(`${t('aiUsageWeek')}: ${q.secondaryUsedPercent}%`);
  if (!parts.length) parts.push(Object.entries(q.raw).map(([k, v]) => `${k}=${v}`).join(', '));
  return parts.join(' · ');
}

async function renderAi(): Promise<void> {
  let auth = await getAiAuth();
  const connected = !!auth;
  els.aiDisconnected.classList.toggle('hidden', connected);
  els.aiConnectedBox.classList.toggle('hidden', !connected);
  if (!auth) return;

  // Heal a stale/invalid model or list (e.g. dashed web slugs from an older version) so the
  // dropdown and the stored selection are valid Codex models — no re-login required.
  const badList = !auth.models || !auth.models.length || auth.models.some((m) => !DEFAULT_MODELS.includes(m));
  const badModel = !auth.model || !DEFAULT_MODELS.includes(auth.model);
  if (badList || badModel) {
    auth = (await patchAiAuth({ models: DEFAULT_MODELS.slice(), model: normalizeModel(auth.model) })) || auth;
  }

  els.aiAccount.textContent = auth.email || auth.accountId || '—';
  els.aiPlan.textContent = auth.planType || '—';
  els.aiUsage.textContent = renderUsage(auth.quota);

  const models = auth.models && auth.models.length ? auth.models : DEFAULT_MODELS;
  els.aiModel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    els.aiModel.appendChild(opt);
  }
  els.aiModel.value = normalizeModel(auth.model);
}

els.aiConnect.addEventListener('click', async () => {
  if (!(await ensureAiPermissions())) {
    aiStatus(t('aiPermDenied'), 'error');
    return;
  }
  aiStatus(t('aiConnecting'));
  els.aiConnect.disabled = true;
  try {
    const auth = await connectAuto();
    aiStatus(t('aiConnectedOk', [auth.email || auth.accountId || '']), 'ok');
    await renderAi();
  } catch {
    // Automatic redirect was rejected or cancelled: fall back to the manual paste flow.
    try {
      const { url } = await beginManualAuth();
      els.aiManual.classList.remove('hidden');
      await chrome.tabs.create({ url });
      aiStatus(t('aiAutoFailedManual')); // recoverable: a tab opened, awaiting the pasted link
    } catch (e) {
      aiStatus(t('aiConnectFailed', [e instanceof Error ? e.message : String(e)]), 'error');
    }
  } finally {
    els.aiConnect.disabled = false;
  }
});

els.aiManualToggle.addEventListener('click', () => {
  els.aiManual.classList.toggle('hidden');
});

els.aiManualOpen.addEventListener('click', async () => {
  if (!(await ensureAiPermissions())) {
    aiStatus(t('aiPermDenied'), 'error');
    return;
  }
  try {
    const { url } = await beginManualAuth();
    await chrome.tabs.create({ url });
  } catch (e) {
    aiStatus(t('aiConnectFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  }
});

els.aiManualComplete.addEventListener('click', async () => {
  const pasted = els.aiPasted.value.trim();
  if (!pasted) return;
  els.aiManualComplete.disabled = true;
  try {
    const auth = await completeManualAuth(pasted);
    els.aiPasted.value = '';
    els.aiManual.classList.add('hidden');
    aiStatus(t('aiConnectedOk', [auth.email || auth.accountId || '']), 'ok');
    await renderAi();
  } catch (e) {
    aiStatus(t('aiConnectFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  } finally {
    els.aiManualComplete.disabled = false;
  }
});

els.aiModel.addEventListener('change', () => {
  void patchAiAuth({ model: els.aiModel.value });
});

els.aiRefresh.addEventListener('click', async () => {
  const auth = await getAiAuth();
  if (!auth) return;
  els.aiRefresh.disabled = true;
  try {
    const fresh = await ensureFreshAuth(auth);
    const models = await fetchModels(fresh);
    const model = models.includes(fresh.model || '') ? fresh.model : models[0];
    const next: AiAuth = { ...fresh, models, model };
    await setAiAuth(next);
    await renderAi();
    aiStatus(t('aiRefreshed'), 'ok');
  } catch (e) {
    aiStatus(t('aiConnectFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  } finally {
    els.aiRefresh.disabled = false;
  }
});

els.aiSignOut.addEventListener('click', async () => {
  await clearAiAuth();
  await renderAi();
  aiStatus(t('aiSignedOut'));
});

// Title prompt: editing stores an explicit override; Restore clears it back to '' so the
// prompt follows the current UI language's default again.
els.aiTitlePrompt.addEventListener('input', () => {
  draft.aiTitlePrompt = els.aiTitlePrompt.value;
});
els.aiPromptRestore.addEventListener('click', () => {
  draft.aiTitlePrompt = '';
  els.aiTitlePrompt.value = t('aiTitlePromptDefault');
});

// ---- Behavior ----
els.closeAfterSubmit.addEventListener('change', () => {
  draft.closeAfterSubmit = els.closeAfterSubmit.checked;
});

// ---- Keyboard shortcut ----
els.shortcutEnabled.addEventListener('change', () => {
  draft.shortcutEnabled = els.shortcutEnabled.checked;
});
// The key combination is assigned on Chrome's own shortcuts page; the extension cannot
// set it programmatically.
els.configureShortcut.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---- Save ----
els.save.addEventListener('click', async () => {
  // Normalize each workspace to only the fields relevant to its provider.
  draft.workspaces = draft.workspaces.map((w) => {
    const provider = getProvider(wsKind(w));
    return { id: w.id || makeId(), kind: provider.id, name: (w.name || '').trim(), ...provider.normalize(w) };
  });

  // Validate per provider.
  for (const w of draft.workspaces) {
    const errKey = getProvider(w.kind).validate(w);
    if (errKey) {
      status(t(errKey), 'error');
      return;
    }
  }
  if (!draft.types.length) {
    status(t('errKeepOneType'), 'error');
    return;
  }

  if (!draft.workspaces.some((w) => w.id === draft.lastWorkspaceId)) {
    draft.lastWorkspaceId = draft.workspaces[0]?.id || '';
  }
  if (!draft.types.includes(draft.lastType)) draft.lastType = draft.types[0] || '';

  // Request host permission for any provider that needs it (this click is the gesture).
  const origins: string[] = [];
  for (const w of draft.workspaces) origins.push(...getProvider(w.kind).permissionOrigins(w));
  if (origins.length) {
    try {
      await chrome.permissions.request({ origins: [...new Set(origins)] });
    } catch {
      /* the user can grant it later at submit time */
    }
  }

  await setConfig(draft);
  renderWorkspaces(); // reflect normalized data
  status(t('saved'), 'ok');
  setTimeout(() => status(''), 2000);
});

// ---- Backup / restore ----
els.exportConfig.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `shot2issue-config-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(t('exported'), 'ok');
});

els.importConfig.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files && els.importFile.files[0];
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text()) as Partial<Config>;
    if (typeof obj !== 'object' || obj === null) throw new Error(t('importInvalid'));
    draft = {
      workspaces: (Array.isArray(obj.workspaces) ? obj.workspaces : []).map((w) => {
        const kind = getProvider(w.kind || 'github').id;
        return { id: w.id || makeId(), kind, name: w.name || '', ...getProvider(kind).normalize(w) };
      }),
      types: Array.isArray(obj.types) && obj.types.length ? obj.types : draft.types,
      lang: typeof obj.lang === 'string' && SUPPORTED_LANGS.includes(obj.lang) ? obj.lang : draft.lang,
      titleTemplate: typeof obj.titleTemplate === 'string' ? obj.titleTemplate : draft.titleTemplate,
      bodyTemplate: typeof obj.bodyTemplate === 'string' ? obj.bodyTemplate : draft.bodyTemplate,
      aiTitlePrompt: typeof obj.aiTitlePrompt === 'string' ? obj.aiTitlePrompt : draft.aiTitlePrompt,
      closeAfterSubmit: typeof obj.closeAfterSubmit === 'boolean' ? obj.closeAfterSubmit : draft.closeAfterSubmit,
      shortcutEnabled: typeof obj.shortcutEnabled === 'boolean' ? obj.shortcutEnabled : draft.shortcutEnabled,
      lastWorkspaceId: typeof obj.lastWorkspaceId === 'string' ? obj.lastWorkspaceId : '',
      lastType: typeof obj.lastType === 'string' ? obj.lastType : '',
    };
    applyDraftToControls();
    setLanguage(draft.lang);
    localizeDom(document);
    renderWorkspaces();
    renderTypes();
    await setConfig(draft);
    status(t('imported'), 'ok');
  } catch (e) {
    status(t('importFailed', [e instanceof Error ? e.message : String(e)]), 'error');
  } finally {
    els.importFile.value = '';
  }
});

function applyDraftToControls(): void {
  els.lang.value = draft.lang;
  els.titleTemplate.value = draft.titleTemplate;
  els.bodyTemplate.value = draft.bodyTemplate;
  // Show the effective prompt: the custom override, or the current language's default.
  els.aiTitlePrompt.value = draft.aiTitlePrompt || t('aiTitlePromptDefault');
  els.closeAfterSubmit.checked = !!draft.closeAfterSubmit;
  els.shortcutEnabled.checked = !!draft.shortcutEnabled;
}

async function init(): Promise<void> {
  draft = await getConfig();
  setLanguage(draft.lang);
  localizeDom(document);
  applyDraftToControls();
  renderWorkspaces();
  renderTypes();
  void renderAi();
}

void init();
