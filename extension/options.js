// Settings page: manage workspaces and types, choose the UI language and behavior,
// and back up / restore the configuration. Everything is stored in chrome.storage.local.
//
// An in-memory draft is edited on the page; it is written to storage only on Save (the
// language change applies immediately so the UI re-localizes as you pick it).

import { getConfig, setConfig, makeId } from './lib/storage.js';
import { setLanguage, localizeDom, t, SUPPORTED_LANGS } from './lib/i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  workspaces: $('workspaces'),
  addWorkspace: $('addWorkspace'),
  typeChips: $('typeChips'),
  newType: $('newType'),
  addType: $('addType'),
  lang: $('lang'),
  closeAfterSubmit: $('closeAfterSubmit'),
  save: $('save'),
  status: $('status'),
  exportConfig: $('exportConfig'),
  importConfig: $('importConfig'),
  importFile: $('importFile'),
};

let draft = null; // { workspaces, types, lang, closeAfterSubmit, lastWorkspaceId, lastType }

function status(text, cls = '') {
  els.status.className = cls;
  els.status.textContent = text;
}

// ---- Workspaces ----
function renderWorkspaces() {
  els.workspaces.innerHTML = '';
  if (!draft.workspaces.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('noWorkspaces');
    els.workspaces.appendChild(p);
  }
  draft.workspaces.forEach((ws, idx) => {
    const card = document.createElement('div');
    card.className = 'ws-card';
    card.innerHTML = `
      <div class="ws-grid">
        <div class="full">
          <label>${t('wsName')}</label>
          <input type="text" data-k="name" placeholder="${t('wsNamePlaceholder')}" />
        </div>
        <div>
          <label>${t('wsOwner')}</label>
          <input type="text" data-k="owner" placeholder="octocat" />
        </div>
        <div>
          <label>${t('wsRepo')}</label>
          <input type="text" data-k="repo" placeholder="hello-world" />
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="danger" data-act="remove">${t('wsRemove')}</button>
      </div>
    `;
    card.querySelector('[data-k="name"]').value = ws.name || '';
    card.querySelector('[data-k="owner"]').value = ws.owner || '';
    card.querySelector('[data-k="repo"]').value = ws.repo || '';

    card.querySelectorAll('input[data-k]').forEach((input) => {
      input.addEventListener('input', () => {
        draft.workspaces[idx][input.dataset.k] = input.value.trim();
      });
    });
    card.querySelector('[data-act="remove"]').addEventListener('click', () => {
      draft.workspaces.splice(idx, 1);
      renderWorkspaces();
    });

    els.workspaces.appendChild(card);
  });
}

els.addWorkspace.addEventListener('click', () => {
  draft.workspaces.push({ id: makeId(), name: '', owner: '', repo: '' });
  renderWorkspaces();
});

// ---- Types ----
function renderTypes() {
  els.typeChips.innerHTML = '';
  draft.types.forEach((ty, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const span = document.createElement('span');
    span.textContent = ty;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.addEventListener('click', () => { draft.types.splice(idx, 1); renderTypes(); });
    chip.appendChild(span);
    chip.appendChild(btn);
    els.typeChips.appendChild(chip);
  });
}

function addType() {
  const v = els.newType.value.trim();
  if (!v) return;
  if (!draft.types.includes(v)) draft.types.push(v);
  els.newType.value = '';
  renderTypes();
}
els.addType.addEventListener('click', addType);
els.newType.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addType(); } });

// ---- Language (applies immediately) ----
els.lang.addEventListener('change', () => {
  draft.lang = SUPPORTED_LANGS.includes(els.lang.value) ? els.lang.value : 'en';
  setLanguage(draft.lang);
  localizeDom(document);
  renderWorkspaces(); // re-render dynamically built content in the new language
  renderTypes();
});

// ---- Behavior ----
els.closeAfterSubmit.addEventListener('change', () => {
  draft.closeAfterSubmit = els.closeAfterSubmit.checked;
});

// ---- Save ----
els.save.addEventListener('click', async () => {
  const bad = draft.workspaces.find((w) => !w.owner || !w.repo);
  if (bad) { status(t('errWorkspaceNeedsOwnerRepo'), 'error'); return; }
  if (!draft.types.length) { status(t('errKeepOneType'), 'error'); return; }

  if (!draft.workspaces.some((w) => w.id === draft.lastWorkspaceId)) draft.lastWorkspaceId = draft.workspaces[0]?.id || '';
  if (!draft.types.includes(draft.lastType)) draft.lastType = draft.types[0] || '';

  await setConfig(draft);
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
    const obj = JSON.parse(await file.text());
    if (typeof obj !== 'object' || obj === null) throw new Error(t('importInvalid'));
    draft = {
      workspaces: (Array.isArray(obj.workspaces) ? obj.workspaces : []).map((w) => ({
        id: w.id || makeId(),
        name: w.name || '',
        owner: w.owner || '',
        repo: w.repo || '',
      })),
      types: Array.isArray(obj.types) && obj.types.length ? obj.types : draft.types,
      lang: SUPPORTED_LANGS.includes(obj.lang) ? obj.lang : draft.lang,
      closeAfterSubmit: typeof obj.closeAfterSubmit === 'boolean' ? obj.closeAfterSubmit : draft.closeAfterSubmit,
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
    status(t('importFailed', [e && e.message ? e.message : String(e)]), 'error');
  } finally {
    els.importFile.value = '';
  }
});

function applyDraftToControls() {
  els.lang.value = draft.lang;
  els.closeAfterSubmit.checked = !!draft.closeAfterSubmit;
}

(async function init() {
  draft = await getConfig();
  setLanguage(draft.lang);
  localizeDom(document);
  applyDraftToControls();
  renderWorkspaces();
  renderTypes();
})();
