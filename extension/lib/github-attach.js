// github.com sign-in detection.
//
// Uploading the screenshot and creating the issue both rely on the user's existing
// github.com web session (see page-upload.js for the in-page injection). This module
// confirms the session before submitting so a signed-out state is reported clearly
// rather than failing silently.

const GH = 'https://github.com';

/**
 * Check whether the user is signed in to github.com (via the web session cookie).
 * When signed in, the page <head> contains <meta name="user-login" content="...">.
 * If that cannot be found, report signed-out conservatively.
 * @returns {Promise<{loggedIn: boolean, login: string}>}
 */
export async function checkGithubLogin() {
  let resp;
  try {
    resp = await fetch(`${GH}/`, { credentials: 'include' });
  } catch (e) {
    throw new Error('Cannot reach github.com (network error or blocked): ' + (e && e.message ? e.message : e));
  }
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const login = doc.querySelector('meta[name="user-login"]')?.getAttribute('content') || '';
  // A sign-in page typically has a password field; use that as a secondary check.
  const looksSignedOut = !login || !!doc.querySelector('input[name="password"]');
  return { loggedIn: !!login && !looksSignedOut, login };
}
