// In-page submission: complete the upload and issue creation inside github.com's
// own new-issue form. No token required.
//
// Rationale (mirrors what existing tools do; see the README):
// GitHub's attachment upload (/upload/policies/assets) is protected by verified-fetch
// plus a same-origin check. A request from the extension origin (chrome-extension://)
// cannot forge same-origin and is rejected (HTTP 422). In addition, an attachment is
// only associated correctly when the composer that uploaded it is submitted; reusing
// the URL from another context makes private-repository images render as 404.
//
// So the extension reproduces what a person does manually, on the target repository's
// issues/new page:
//   1. wait for the form to hydrate;
//   2. fill in the title and description;
//   3. simulate a paste (primary) or drop (fallback) of a PNG onto the body textarea,
//      letting GitHub's own page code perform the upload (genuinely same-origin) and
//      insert the ![](url) markdown;
//   4. once the upload has truly finished, click "Create" — upload and submission share
//      one composer session, so the attachment renders;
//   5. poll the tab URL until it navigates to the created issue and return that URL.
//
// Note: the modern issues/new page is a React editor with no <input type=file> (the
// button reads "Paste, drop, or click to add files"), so paste/drop events are used.
// The whole flow runs in a background tab (active:false) so focus is not stolen.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create an issue through github.com's web form, optionally with a screenshot.
 * @param {{owner:string, repo:string, title:string, body:string, dataUrl:string, filename:string, withImage:boolean}} opts
 * @returns {Promise<string>} URL of the created issue
 */
export async function submitIssueViaPage({ owner, repo, title, body, dataUrl, filename, withImage }) {
  const newIssueUrl = `https://github.com/${owner}/${repo}/issues/new`;
  // Background tab (active:false): does not steal focus or interrupt the user.
  const tab = await chrome.tabs.create({ url: newIssueUrl, active: false });
  const tabId = tab.id;
  try {
    await waitTabReady(tabId);
    const injections = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageCreateIssue,
      args: [{ title, body, dataUrl: withImage ? dataUrl : '', filename, withImage: !!withImage }],
    });
    const res = injections?.[0]?.result;
    if (!res) throw new Error('The injected script returned no result (possibly signed out or no access to the repository).');
    if (!res.ok) throw new Error(res.error || 'Web-form submission failed.');
    // After clicking Create, poll the URL until it moves from /issues/new to /issues/{number}.
    return await waitForCreatedIssue(tabId);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (_) { /* ignore */ }
  }
}

/** Poll the tab URL until it navigates to a created issue (/issues/{number}). */
async function waitForCreatedIssue(tabId) {
  for (let i = 0; i < 40; i++) { // ~20s
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href });
      const href = r?.result || '';
      if (/https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:[?#]|$)/.test(href)) {
        return href.split(/[?#]/)[0];
      }
    } catch (_) { /* navigating; keep waiting */ }
    await sleep(500);
  }
  throw new Error('Clicked Create but no navigation to a new issue was detected (form validation may have failed, or submission was rejected).');
}

/**
 * Wait until the tab has loaded issues/new and the DOM is ready. Probed via
 * executeScript to avoid requiring the "tabs" permission; a redirect to the
 * sign-in page is reported immediately.
 */
async function waitTabReady(tabId) {
  for (let i = 0; i < 60; i++) { // up to ~30s
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ url: location.href, ready: document.readyState }),
      });
      const v = r?.result;
      if (v) {
        if (/\/login(\?|$)/.test(v.url)) {
          throw new Error('Not signed in to github.com (redirected to the sign-in page). Sign in to github.com in this browser and try again.');
        }
        if (/\/issues\/new/.test(v.url) && v.ready !== 'loading') return;
      }
    } catch (e) {
      if (String(e?.message || e).includes('Not signed in')) throw e;
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for the github.com new-issue page to load (30s).');
}

/**
 * Function injected into the issues/new page (MAIN world). It uploads the screenshot
 * (optional), fills the title and body, and clicks Create. Returns { ok } or
 * { ok:false, error }. Self-contained: references only its arguments and page globals.
 */
function pageCreateIssue(opts) {
  const { title, body, dataUrl, filename, withImage } = opts;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findTitle() {
    return (
      document.querySelector('input[aria-label="Add a title"]') ||
      document.querySelector('input[placeholder="Title"]') ||
      document.querySelector('input[name="issue[title]"]') ||
      document.querySelector('#issue_title')
    );
  }
  function findBody() {
    return (
      document.querySelector('textarea[aria-label="Markdown value"]') ||
      document.querySelector('textarea[aria-label*="markdown" i]') ||
      document.querySelector('textarea[name="issue[body]"]') ||
      document.querySelector('#issue_body') ||
      document.querySelector('textarea[placeholder*="description" i]') ||
      document.querySelector('textarea.prc-Textarea-TextArea-snlco')
    );
  }
  function findCreateBtn() {
    return (
      document.querySelector('[data-testid="create-issue-button"]') ||
      Array.from(document.querySelectorAll('button')).find((b) => {
        const label = (b.textContent || '').trim();
        return /^create/i.test(label) && !/more/i.test(label);
      }) ||
      null
    );
  }
  // React controlled inputs: set value via the native setter, then dispatch an input
  // event so React adopts the new value.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // dataURL -> File via atob. Not fetch(dataUrl): github.com's CSP blocks data: URLs.
  function dataUrlToFile(durl, name) {
    const comma = durl.indexOf(',');
    const mime = (durl.slice(0, comma).match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(durl.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  return (async () => {
    // 1) Wait for the title and body fields.
    let titleEl = null, bodyEl = null;
    for (let i = 0; i < 60 && !(titleEl && bodyEl); i++) {
      titleEl = findTitle();
      bodyEl = findBody();
      if (!(titleEl && bodyEl)) await sleep(300);
    }
    if (!titleEl || !bodyEl) {
      return { ok: false, error: 'Could not find the title/body fields (the page structure may have changed, or the repository enforces issue templates).' };
    }

    // 2) Fill the title and description, then move the caret to the end so the image
    //    is appended after the text. Do NOT overwrite the image markdown that GitHub
    //    inserts and manages: keeping the upload and submission in one composer session
    //    is what makes the attachment render (otherwise private repos 404).
    setNativeValue(titleEl, title);
    const desc = (body || '').trimEnd();
    setNativeValue(bodyEl, desc ? desc + '\n\n' : '');
    try { bodyEl.focus(); bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length); } catch (_) {}

    // 3) Upload the screenshot (optional): paste first, drop as a fallback, letting
    //    GitHub append ![](url) and manage the upload. Continue only once the URL is
    //    present and "Uploading…" is gone (upload truly complete).
    if (withImage && dataUrl) {
      let file;
      try {
        file = dataUrlToFile(dataUrl, filename);
      } catch (e) {
        return { ok: false, error: 'Failed to convert image data: ' + (e && e.message ? e.message : e) };
      }
      const makeDT = () => { const dt = new DataTransfer(); dt.items.add(file); return dt; };
      const firePaste = () => { try { bodyEl.focus(); bodyEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: makeDT() })); } catch (_) {} };
      const fireDrop = () => {
        try {
          bodyEl.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: makeDT() }));
          bodyEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: makeDT() }));
          bodyEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: makeDT() }));
        } catch (_) {}
      };
      firePaste();
      const re = /https:\/\/github\.com\/(?:user-attachments\/assets|[^/\s)]+\/[^/\s)]+\/assets)\/[^\s)]+/;
      let done = false, sawUploading = false, triedDrop = false;
      for (let i = 0; i < 160; i++) { // ~48s, allow ample time for the upload
        const val = bodyEl.value || '';
        if (/uploading/i.test(val)) sawUploading = true;
        if (re.test(val) && !/uploading/i.test(val)) { done = true; break; }
        if (i === 10 && !sawUploading && !triedDrop) { fireDrop(); triedDrop = true; }
        await sleep(300);
      }
      if (!done) {
        return {
          ok: false,
          error: sawUploading
            ? 'Upload timed out: "Uploading…" appeared but did not complete.'
            : 'Upload timed out: paste/drop did not trigger an upload.',
        };
      }
      await sleep(500); // let the editor settle before submitting
    }

    // 4) Click Create (enabled once the title is non-empty). Do not overwrite the body.
    const btn = findCreateBtn();
    if (!btn) return { ok: false, error: 'Could not find the Create button (the page structure may have changed).' };
    for (let i = 0; i < 20 && btn.disabled; i++) await sleep(150);
    btn.click();
    return { ok: true };
  })();
}
