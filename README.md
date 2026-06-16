# shot2issue

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A Chrome extension (Manifest V3) for filing GitHub issues from a screenshot. Click the
toolbar icon to capture the current tab, annotate the image, write a title and
description, and submit. The screenshot is attached as a native GitHub
`user-attachments` asset and rendered inline in the issue body.

The extension is client-side only. It communicates with `github.com` and nothing else,
and it requires no personal access token: submission uses your existing github.com
browser session.

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="shot2issue icon" />
</p>

## Features

- One click to capture the visible area of the current tab.
- Canvas annotation: rectangle, arrow, text, and mosaic (for redacting sensitive
  content before submitting).
- Multiple workspaces, each targeting one repository (public or private).
- Submission runs in a background tab without stealing focus; the editor can optionally
  close and return you to the page you captured.
- Interface available in English, Simplified Chinese, and Japanese (English by default).
- No token, no backend, no analytics. Settings are stored locally and can be exported.

## Requirements

- Google Chrome (or a Chromium-based browser) with Manifest V3 support.
- An active github.com session in the same browser. The signed-in account must have
  access to the target repository, including private repositories.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Choose **Load unpacked** and select the **`extension/`** directory (the subdirectory,
   not the repository root).
5. The options page opens on first install. Add at least one workspace.

A packaged build (`dist/shot2issue-<version>.zip`, see [Building](#building)) can be
loaded the same way or uploaded to the Chrome Web Store.

To update after pulling new code, use the **Reload** button on the extension card in
`chrome://extensions`. Settings are preserved across reloads; removing the extension
clears them.

## Usage

1. Open the page you want to capture and click the shot2issue toolbar icon. The visible
   area is captured and the editor opens in a new tab.
2. In the editor, choose a workspace and type, annotate the screenshot, and edit the
   title and description. The title defaults to the page title followed by the selected
   type; the body is prefilled with the page URL.
3. Click **Submit issue**. The extension opens the target repository's new-issue page in
   a background tab, uploads the screenshot, fills in the form, and submits. On success
   it shows a link to the issue (and, if enabled, returns you to the captured page).

If submission fails, use **Download PNG** to save the annotated image and attach it
manually, or **Submit without screenshot** to file the issue without the image.

## Configuration

Open the options page from `chrome://extensions` (Details → Extension options) or from
the **Settings** link in the editor.

- **Workspaces** — each workspace is one target repository, defined by a display name,
  an owner (user or organization), and a repository name.
- **Types** — shown in the editor's Type dropdown and used as the default title suffix.
  Defaults: Change, Bug, Feature.
- **Language** — English, Simplified Chinese, or Japanese.
- **Behavior** — whether to close the editor and switch back to the captured page after a
  successful submission.
- **Backup / restore** — export settings to a JSON file and import them later. Settings
  are stored only in this browser (`chrome.storage.local`).

## How submission works

GitHub issue attachments (`user-attachments/assets`) have no official API: personal
access tokens, OAuth, and GitHub Apps cannot upload them. Only the github.com web
session can. The extension therefore reproduces what a person does manually, on the
target repository's new-issue page:

1. Open `https://github.com/<owner>/<repo>/issues/new` in a background tab.
2. Inject a script (via `chrome.scripting.executeScript` in the page's main world) that
   fills in the title and description and pastes the screenshot into the body. GitHub's
   own page code performs the upload, which is genuinely same-origin and therefore
   passes its verified-fetch checks, and inserts the `![](url)` markdown.
3. Wait until the upload has completed, then click **Create**.
4. Read the resulting issue URL and close the background tab.

Two constraints make this the only reliable approach:

- A cross-origin request from the extension to GitHub's upload endpoint cannot forge a
  same-origin context and is rejected (HTTP 422).
- An attachment is associated correctly only when the composer that uploaded it is
  submitted. Uploading in one place and referencing the URL from another (for example,
  an issue created through the REST API) causes the image to return 404 in private
  repositories.

The screenshot's data URL is decoded with `atob` rather than `fetch`, because
github.com's content security policy blocks `fetch` of `data:` URLs.

This path depends on the structure of GitHub's web UI and may need updating if that UI
changes. The code uses several selectors, a paste-then-drop fallback, and explicit
timeouts. The **Download PNG** and **Submit without screenshot** actions remain available
as fallbacks.

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Granted when the icon is clicked; used to capture the visible tab and read its title and URL. |
| `storage` | Stores settings in `chrome.storage.local` and the pending screenshot in `chrome.storage.session`. |
| `scripting` | Injects the submission script into the background github.com tab. |

Host permissions are limited to `https://github.com/*`, which is the only origin the
extension contacts. The screenshot bytes are uploaded to GitHub's storage by GitHub's
own page code, so the extension does not need permission for those storage hosts.

## Privacy

- Only the screenshot, title, description, and the current page URL are used. The
  extension does not collect console output, network activity, or device information,
  and includes no telemetry.
- Attachment visibility follows repository visibility. Attachments in private
  repositories require sign-in to view (since 2023-05); attachments in public
  repositories are visible anonymously. Choose the target repository accordingly.
- The mosaic tool provides redaction: cover sensitive content before submitting. It
  samples the original screenshot and pixelates the selected region.
- No token or secret is stored; the extension relies on your existing github.com
  session.

## Project structure

```
shot2issue/
├── extension/                   # load unpacked points here
│   ├── manifest.json            # MV3 manifest; host permissions limited to github.com
│   ├── background.js            # service worker: capture on icon click, open the editor
│   ├── editor.html / .js / .css # main UI: selection, canvas annotation, submission
│   ├── options.html / .js       # settings: workspaces, types, language, backup
│   ├── lib/
│   │   ├── storage.js           # chrome.storage access (settings + pending screenshot)
│   │   ├── i18n.js              # interface strings (en / zh / ja)
│   │   ├── page-upload.js       # in-page submission via github.com's web form
│   │   └── github-attach.js     # github.com sign-in detection
│   └── icons/                   # 16 / 48 / 128 px icons
├── scripts/build.sh             # validate the manifest and package the zip
├── Dockerfile                   # Docker build for the release archive
├── .github/workflows/build.yml  # CI: Docker build, upload artifact, attach to releases
├── LICENSE
└── README.md
```

## Building

Development with **Load unpacked** does not require a build. The build only produces a
distributable archive containing the contents of `extension/`.

With Docker:

```bash
docker build --target export --output type=local,dest=dist .
```

Or directly (requires `bash` and `zip`; `jq` optional):

```bash
bash scripts/build.sh
# Output: dist/shot2issue-<version>.zip
```

Continuous integration ([`.github/workflows/build.yml`](.github/workflows/build.yml))
runs the Docker build on every push to `main`, on pull requests, and on manual runs,
uploading the archive as a workflow artifact. Pushing a `v*` tag also attaches the
archive to a GitHub release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Limitations

- Captures the visible area only; full-page or scrolling capture is not supported.
- Restricted pages such as `chrome://` and the Chrome Web Store cannot be captured; the
  editor reports this.
- Labels are not set automatically.
- The submission flow depends on GitHub's current web UI and may require updates when
  that UI changes.

## License

[MIT](LICENSE)
