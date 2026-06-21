// Settings page: manage workspaces (any provider) and types, choose the UI language,
// behavior, and keyboard shortcut, and back up / restore the configuration. Everything is
// stored in chrome.storage.local.
//
// An in-memory draft is edited on the page and written to storage only on Save (the
// language change applies immediately so the UI re-localizes as you pick it).

import {
  getConfig,
  setConfig,
  makeId,
  makeAccountId,
  migrateAccounts,
  getOptionsTab,
  setOptionsTab,
  getAiAuth,
  setAiAuth,
  patchAiAuth,
  clearAiAuth,
} from './lib/storage.js';
import { setLanguage, localizeDom, t, SUPPORTED_LANGS } from './lib/i18n.js';
import { PROVIDER_LIST, getProvider, isAccountBased, accountKinds } from './lib/providers/index.js';
import {
  connectViaCallbackCapture,
  beginManualAuth,
  completeManualAuth,
  ensureAiPermissions,
  ensureFreshAuth,
  fetchModels,
  isValidModelSlug,
  MODEL_DATES,
  DEFAULT_MODELS,
} from './lib/ai.js';
import type { Config, Workspace, Account, AiAuth, AiQuota } from './lib/types.js';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const els = {
  tabBar: $('tabBar'),
  accounts: $('accounts'),
  addAccount: $('addAccount'),
  workspaces: $('workspaces'),
  addWorkspace: $('addWorkspace'),
  typeChips: $('typeChips'),
  newType: $('newType') as HTMLInputElement,
  addType: $('addType'),
  vocabChips: $('vocabChips'),
  newVocab: $('newVocab') as HTMLInputElement,
  addVocab: $('addVocab'),
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
  aiComplaintPrompt: $('aiComplaintPrompt') as HTMLTextAreaElement,
  aiComplaintRestore: $('aiComplaintRestore') as HTMLButtonElement,
};

let draft: Config;

const wsKind = (ws: Workspace): string => ws.kind || 'github';

// Workspace cards are collapsed by default and expanded only while editing. This holds the
// ids of the currently expanded cards (survives re-renders, e.g. on a target-kind change).
const expandedWs = new Set<string>();

/** One-line summary shown on a collapsed workspace card. */
function wsSummary(ws: Workspace): string {
  const provider = getProvider(wsKind(ws));
  const name = (ws.name || '').trim() || t('wsUntitled');
  let detail = '';
  if (isAccountBased(provider)) {
    detail = (ws.project || '').trim();
  } else {
    const owner = (ws.owner || '').trim();
    const repo = (ws.repo || '').trim();
    if (owner || repo) detail = `${owner}/${repo}`;
  }
  return detail ? `${name} · ${provider.label} · ${detail}` : `${name} · ${provider.label}`;
}

// Account cards are likewise collapsed by default and expanded only while editing.
const expandedAcct = new Set<string>();

/** One-line summary shown on a collapsed account card. */
function acctSummary(acct: Account): string {
  const label = getProvider(acct.kind).label;
  const name = (acct.name || '').trim() || t('accountUntitled');
  let host = '';
  try {
    host = acct.baseUrl ? new URL(acct.baseUrl).host : '';
  } catch {
    host = acct.baseUrl || '';
  }
  return host ? `${name} · ${label} · ${host}` : `${name} · ${label}`;
}

/** Two-step delete: the first click arms the button ("Click again to confirm"); the second confirms. */
function wireConfirmRemove(btn: HTMLButtonElement, onConfirm: () => void): void {
  let armed = false;
  let timer: number | undefined;
  const label = btn.textContent || '';
  btn.addEventListener('click', () => {
    if (armed) {
      window.clearTimeout(timer);
      onConfirm();
      return;
    }
    armed = true;
    btn.textContent = t('confirmRemove');
    btn.classList.add('armed');
    timer = window.setTimeout(() => {
      armed = false;
      btn.textContent = label;
      btn.classList.remove('armed');
    }, 3000);
  });
}

function status(text: string, cls = ''): void {
  els.status.className = cls;
  els.status.textContent = text;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---- Tabs ----
function showTab(name: string): void {
  els.tabBar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', (p as HTMLElement).dataset.panel === name));
  void setOptionsTab(name);
}
els.tabBar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.tab') as HTMLElement | null;
  if (btn && btn.dataset.tab) showTab(btn.dataset.tab);
});

/** Overlay the bound Account's baseUrl/token for account-based workspaces (for validation). */
function mergeWs(w: Workspace): Workspace {
  const acct = w.accountId ? draft.accounts.find((a) => a.id === w.accountId) : null;
  return acct ? { ...w, baseUrl: acct.baseUrl, token: acct.token } : w;
}

// ---- Accounts ----
function fieldInputsHtml(fields: { key: string; labelKey: string; type?: string; placeholder?: string; placeholderKey?: string; full?: boolean }[]): string {
  return fields
    .map((f) => {
      const ph = f.placeholderKey ? t(f.placeholderKey) : f.placeholder || '';
      const type = f.type === 'password' ? 'password' : 'text';
      return `<div class="${f.full ? 'full' : ''}"><label>${t(f.labelKey)}</label><input type="${type}" data-k="${escapeAttr(f.key)}" placeholder="${escapeAttr(ph)}" /></div>`;
    })
    .join('');
}

function renderAccounts(): void {
  els.accounts.innerHTML = '';
  if (!draft.accounts.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('noAccounts');
    els.accounts.appendChild(p);
  }
  draft.accounts.forEach((acct, idx) => {
    const provider = getProvider(acct.kind);
    const collapsed = !expandedAcct.has(acct.id);
    const card = document.createElement('div');
    card.className = collapsed ? 'acct-card collapsed' : 'acct-card';
    const kindOptions = accountKinds
      .map((k) => `<option value="${escapeAttr(k)}">${escapeAttr(getProvider(k).label)}</option>`)
      .join('');
    card.innerHTML = `
      <div class="acct-head">
        <button type="button" class="acct-toggle" data-act="toggle">
          <span class="acct-chev">${collapsed ? '▸' : '▾'}</span>
          <span class="acct-summary">${escapeAttr(acctSummary(acct))}</span>
        </button>
      </div>
      <div class="acct-body">
        <div class="acct-grid">
          <div class="full"><label>${t('accountName')}</label><input type="text" data-k="name" placeholder="${escapeAttr(t('accountNamePlaceholder'))}" /></div>
          <div class="full"><label>${t('accountKind')}</label><select data-k="kind" style="max-width:200px;">${kindOptions}</select></div>
          ${fieldInputsHtml(provider.accountFields || [])}
        </div>
        <div class="row" style="margin-top:10px;"><button class="danger" data-act="remove">${t('accountRemove')}</button></div>
      </div>`;

    const rec = acct as unknown as Record<string, string>;
    (card.querySelector('[data-k="name"]') as HTMLInputElement).value = acct.name || '';
    (card.querySelector('[data-k="kind"]') as HTMLSelectElement).value = acct.kind;
    for (const f of provider.accountFields || []) {
      const input = card.querySelector(`[data-k="${f.key}"]`) as HTMLInputElement | null;
      if (input) input.value = rec[f.key] || '';
    }
    const summaryEl = card.querySelector('.acct-summary') as HTMLElement;
    const chevEl = card.querySelector('.acct-chev') as HTMLElement;
    card.querySelectorAll('[data-k]').forEach((node) => {
      const input = node as HTMLInputElement | HTMLSelectElement;
      const k = input.dataset.k as string;
      if (k === 'kind') {
        input.addEventListener('change', () => {
          draft.accounts[idx].kind = input.value;
          renderAccounts();
          renderWorkspaces(); // account-kind change affects which accounts a workspace can pick
        });
      } else {
        input.addEventListener('input', () => {
          (draft.accounts[idx] as unknown as Record<string, string>)[k] = input.value;
          summaryEl.textContent = acctSummary(draft.accounts[idx]);
        });
      }
    });
    (card.querySelector('[data-act="toggle"]') as HTMLButtonElement).addEventListener('click', () => {
      const nowCollapsed = card.classList.toggle('collapsed');
      if (nowCollapsed) expandedAcct.delete(acct.id);
      else expandedAcct.add(acct.id);
      chevEl.textContent = nowCollapsed ? '▸' : '▾';
    });
    wireConfirmRemove(card.querySelector('[data-act="remove"]') as HTMLButtonElement, () => {
      expandedAcct.delete(acct.id);
      draft.accounts.splice(idx, 1);
      renderAccounts();
      renderWorkspaces();
    });
    els.accounts.appendChild(card);
  });
}

els.addAccount.addEventListener('click', () => {
  const id = makeAccountId();
  draft.accounts.push({ id, kind: accountKinds[0] || 'youtrack', name: '', baseUrl: '', token: '' });
  expandedAcct.add(id); // a freshly added account opens expanded for editing
  renderAccounts();
});

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
    const collapsed = !expandedWs.has(ws.id);
    const card = document.createElement('div');
    card.className = collapsed ? 'ws-card collapsed' : 'ws-card';

    const targetOptions = PROVIDER_LIST.map(
      (p) => `<option value="${escapeAttr(p.id)}">${escapeAttr(p.label)}</option>`
    ).join('');

    let fieldHtml: string;
    if (isAccountBased(provider)) {
      // Account picker (filtered to this kind) + the project field.
      const accts = draft.accounts.filter((a) => a.kind === provider.id);
      const acctOptions =
        `<option value="">${escapeAttr(t('accountNone'))}</option>` +
        accts.map((a) => `<option value="${escapeAttr(a.id)}">${escapeAttr(a.name || a.baseUrl || a.id)}</option>`).join('');
      const pf = provider.projectField as { key: string; labelKey: string; placeholder?: string; placeholderKey?: string };
      const pph = pf.placeholderKey ? t(pf.placeholderKey) : pf.placeholder || '';
      fieldHtml = `
        <div class="full"><label>${t('wsAccount')}</label><select data-k="accountId">${acctOptions}</select></div>
        <div class="full"><label>${t(pf.labelKey)}</label><input type="text" data-k="${escapeAttr(pf.key)}" placeholder="${escapeAttr(pph)}" /></div>`;
    } else {
      fieldHtml = fieldInputsHtml(provider.fields);
    }

    const hintHtml = provider.hintKey
      ? `<div class="full"><p class="hint" style="margin:4px 0 0;">${t(provider.hintKey)}</p></div>`
      : '';

    card.innerHTML = `
      <div class="ws-head">
        <button type="button" class="ws-toggle" data-act="toggle">
          <span class="ws-chev">${collapsed ? '▸' : '▾'}</span>
          <span class="ws-summary">${escapeAttr(wsSummary(ws))}</span>
        </button>
      </div>
      <div class="ws-body">
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
        <div class="row" style="margin-top:10px;"><button class="danger" data-act="remove">${t('wsRemove')}</button></div>
      </div>
    `;

    (card.querySelector('[data-k="name"]') as HTMLInputElement).value = ws.name || '';
    (card.querySelector('[data-k="kind"]') as HTMLSelectElement).value = kind;
    const summaryEl = card.querySelector('.ws-summary') as HTMLElement;
    const chevEl = card.querySelector('.ws-chev') as HTMLElement;
    card.querySelectorAll('[data-k]').forEach((node) => {
      const input = node as HTMLInputElement | HTMLSelectElement;
      const k = input.dataset.k as string;
      if (k === 'name' || k === 'kind') {
        if (k === 'kind') {
          input.addEventListener('change', () => {
            draft.workspaces[idx].kind = input.value;
            renderWorkspaces(); // swap to the fields for the chosen target
          });
        } else {
          input.addEventListener('input', () => {
            draft.workspaces[idx].name = input.value;
            summaryEl.textContent = wsSummary(draft.workspaces[idx]);
          });
        }
        return;
      }
      input.value = ws[k] || ''; // accountId, project, owner, repo
      const evt = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        draft.workspaces[idx][k] = input.value.trim();
        summaryEl.textContent = wsSummary(draft.workspaces[idx]);
      });
    });
    (card.querySelector('[data-act="toggle"]') as HTMLButtonElement).addEventListener('click', () => {
      const nowCollapsed = card.classList.toggle('collapsed');
      if (nowCollapsed) expandedWs.delete(ws.id);
      else expandedWs.add(ws.id);
      chevEl.textContent = nowCollapsed ? '▸' : '▾';
    });
    wireConfirmRemove(card.querySelector('[data-act="remove"]') as HTMLButtonElement, () => {
      expandedWs.delete(ws.id);
      draft.workspaces.splice(idx, 1);
      renderWorkspaces();
    });

    els.workspaces.appendChild(card);
  });
}

els.addWorkspace.addEventListener('click', () => {
  const id = makeId();
  draft.workspaces.push({ id, kind: 'github', name: '', owner: '', repo: '' });
  expandedWs.add(id); // a freshly added workspace opens expanded for editing
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

// ---- Voice-input dictionary (sent as a transcription prompt) ----
function renderVocab(): void {
  els.vocabChips.innerHTML = '';
  (draft.aiVocabulary || []).forEach((term, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const span = document.createElement('span');
    span.textContent = term;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      draft.aiVocabulary.splice(idx, 1);
      renderVocab();
    });
    chip.appendChild(span);
    chip.appendChild(btn);
    els.vocabChips.appendChild(chip);
  });
}

function addVocabTerm(): void {
  const v = els.newVocab.value.trim();
  if (!v) return;
  if (!Array.isArray(draft.aiVocabulary)) draft.aiVocabulary = [];
  if (!draft.aiVocabulary.includes(v)) draft.aiVocabulary.push(v);
  els.newVocab.value = '';
  renderVocab();
}
els.addVocab.addEventListener('click', addVocabTerm);
els.newVocab.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addVocabTerm();
  }
});

// ---- Language (applies immediately) ----
els.lang.addEventListener('change', () => {
  draft.lang = SUPPORTED_LANGS.includes(els.lang.value) ? els.lang.value : 'en';
  setLanguage(draft.lang);
  localizeDom(document);
  renderAccounts();
  renderWorkspaces(); // re-render dynamically built content in the new language
  renderTypes();
  void renderAi();
  // If a prompt is not customized, show the new language's default.
  if (!draft.aiTitlePrompt) els.aiTitlePrompt.value = t('aiTitlePromptDefault');
  if (!draft.aiComplaintPrompt) els.aiComplaintPrompt.value = t('aiComplaintPromptDefault');
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

  // Drop any legacy dashed slugs (e.g. "gpt-5-5" from an older version) and fix the selected
  // model — no re-login required. A real list is fetched on connect / Refresh.
  const sane = (auth.models || []).filter(isValidModelSlug);
  const models = sane.length ? sane : DEFAULT_MODELS.slice();
  const model = models.includes(auth.model || '') ? (auth.model as string) : models[0];
  if (model !== auth.model || sane.length !== (auth.models?.length ?? 0)) {
    auth = (await patchAiAuth({ models, model })) || auth;
  }

  els.aiAccount.textContent = auth.email || auth.accountId || '—';
  els.aiPlan.textContent = auth.planType || '—';
  els.aiUsage.textContent = renderUsage(auth.quota);

  els.aiModel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = MODEL_DATES[m] ? `${m} (${t('aiModelAdded', [MODEL_DATES[m]])})` : m;
    els.aiModel.appendChild(opt);
  }
  els.aiModel.value = model;
}

els.aiConnect.addEventListener('click', async () => {
  if (!(await ensureAiPermissions())) {
    aiStatus(t('aiPermDenied'), 'error');
    return;
  }
  aiStatus(t('aiConnecting'));
  els.aiManual.classList.remove('hidden'); // show the paste fallback alongside auto-capture
  els.aiConnect.disabled = true;
  try {
    // Opens the sign-in tab and auto-captures the localhost ?code= (no manual paste needed).
    const auth = await connectViaCallbackCapture();
    els.aiManual.classList.add('hidden');
    aiStatus(t('aiConnectedOk', [auth.email || auth.accountId || '']), 'ok');
    await renderAi();
  } catch (e) {
    // Auto-capture timed out — but a manual paste may have completed it in the meantime.
    if (await getAiAuth()) {
      els.aiManual.classList.add('hidden');
      aiStatus(t('aiConnectedOk', ['']), 'ok');
      await renderAi();
    } else {
      aiStatus(t('aiAutoFailedManual')); // the tab + paste box are available to finish manually
    }
  } finally {
    els.aiConnect.disabled = false;
  }
});

els.aiManualToggle.addEventListener('click', () => {
  els.aiManual.classList.toggle('hidden');
});

els.aiManualOpen.addEventListener('click', async () => {
  // An auto-capture is already in flight (aiConnect disabled): it has its own tab + pending
  // PKCE. Don't call beginManualAuth again — that would overwrite the pending state and break
  // the auto-capture. The tab it opened is already there for the user to paste from.
  if (els.aiConnect.disabled) {
    aiStatus(t('aiConnecting'));
    return;
  }
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
els.aiComplaintPrompt.addEventListener('input', () => {
  draft.aiComplaintPrompt = els.aiComplaintPrompt.value;
});
els.aiComplaintRestore.addEventListener('click', () => {
  draft.aiComplaintPrompt = '';
  els.aiComplaintPrompt.value = t('aiComplaintPromptDefault');
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
  // 1) Normalize + validate accounts first.
  draft.accounts = draft.accounts.map((a) => ({
    id: a.id || makeAccountId(),
    kind: a.kind,
    name: (a.name || '').trim(),
    baseUrl: (a.baseUrl || '').trim().replace(/\/+$/, ''),
    token: (a.token || '').trim(),
  }));
  for (const a of draft.accounts) {
    if (!a.name || !a.baseUrl || !a.token) {
      showTab('accounts');
      status(t('errAccountIncomplete'), 'error');
      return;
    }
  }

  // 2) Normalize workspaces to the fields relevant to their provider (explicit loop).
  const normalized: Workspace[] = [];
  for (const w of draft.workspaces) {
    const provider = getProvider(wsKind(w));
    normalized.push({ id: w.id || makeId(), kind: provider.id, name: (w.name || '').trim(), ...provider.normalize(w) });
  }
  draft.workspaces = normalized;

  // 3) Validate each workspace against the merged (account creds overlaid) shape.
  for (const w of draft.workspaces) {
    const errKey = getProvider(w.kind).validate(mergeWs(w));
    if (errKey) {
      expandedWs.add(w.id); // reveal the card with the problem
      renderWorkspaces();
      showTab('workspaces');
      status(t(errKey), 'error');
      return;
    }
  }
  if (!draft.types.length) {
    showTab('workspaces');
    status(t('errKeepOneType'), 'error');
    return;
  }

  if (!draft.workspaces.some((w) => w.id === draft.lastWorkspaceId)) {
    draft.lastWorkspaceId = draft.workspaces[0]?.id || '';
  }
  if (!draft.types.includes(draft.lastType)) draft.lastType = draft.types[0] || '';

  // Request host permission for any provider that needs it (this click is the gesture).
  const origins: string[] = [];
  for (const w of draft.workspaces) origins.push(...getProvider(w.kind).permissionOrigins(mergeWs(w)));
  if (origins.length) {
    try {
      await chrome.permissions.request({ origins: [...new Set(origins)] });
    } catch {
      /* the user can grant it later at submit time */
    }
  }

  await setConfig(draft);
  renderAccounts();
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
    // Preserve all workspace fields (accountId/project/owner/repo, and any legacy inline
    // baseUrl/token) so migrateAccounts can convert old backups losslessly.
    const imported: Config = {
      workspaces: (Array.isArray(obj.workspaces) ? obj.workspaces : []).map((w) => ({
        ...w,
        id: w.id || makeId(),
        kind: getProvider(w.kind || 'github').id,
        name: w.name || '',
      })),
      accounts: Array.isArray(obj.accounts) ? (obj.accounts as Account[]) : [],
      types: Array.isArray(obj.types) && obj.types.length ? obj.types : draft.types,
      lang: typeof obj.lang === 'string' && SUPPORTED_LANGS.includes(obj.lang) ? obj.lang : draft.lang,
      titleTemplate: typeof obj.titleTemplate === 'string' ? obj.titleTemplate : draft.titleTemplate,
      bodyTemplate: typeof obj.bodyTemplate === 'string' ? obj.bodyTemplate : draft.bodyTemplate,
      aiTitlePrompt: typeof obj.aiTitlePrompt === 'string' ? obj.aiTitlePrompt : draft.aiTitlePrompt,
      aiComplaintPrompt: typeof obj.aiComplaintPrompt === 'string' ? obj.aiComplaintPrompt : draft.aiComplaintPrompt,
      aiVocabulary: Array.isArray(obj.aiVocabulary) ? (obj.aiVocabulary as string[]) : draft.aiVocabulary,
      closeAfterSubmit: typeof obj.closeAfterSubmit === 'boolean' ? obj.closeAfterSubmit : draft.closeAfterSubmit,
      shortcutEnabled: typeof obj.shortcutEnabled === 'boolean' ? obj.shortcutEnabled : draft.shortcutEnabled,
      lastWorkspaceId: typeof obj.lastWorkspaceId === 'string' ? obj.lastWorkspaceId : '',
      lastType: typeof obj.lastType === 'string' ? obj.lastType : '',
    };
    draft = migrateAccounts(imported); // convert any legacy inline-cred workspaces to accounts
    applyDraftToControls();
    setLanguage(draft.lang);
    localizeDom(document);
    renderAccounts();
    renderWorkspaces();
    renderTypes();
    renderVocab();
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
  // Show the effective prompts: the custom override, or the current language's default.
  els.aiTitlePrompt.value = draft.aiTitlePrompt || t('aiTitlePromptDefault');
  els.aiComplaintPrompt.value = draft.aiComplaintPrompt || t('aiComplaintPromptDefault');
  els.closeAfterSubmit.checked = !!draft.closeAfterSubmit;
  els.shortcutEnabled.checked = !!draft.shortcutEnabled;
}

async function init(): Promise<void> {
  draft = await getConfig();
  setLanguage(draft.lang);
  localizeDom(document);
  applyDraftToControls();
  renderAccounts();
  renderWorkspaces();
  renderTypes();
  renderVocab();
  void renderAi();
  showTab(await getOptionsTab());
}

void init();
