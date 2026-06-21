# shot2issue

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**Capture a screenshot, annotate it, and file it as a GitHub, GitLab, or YouTrack issue — with the image embedded inline, without leaving the browser.** No Personal Access Token for GitHub, no backend, no telemetry. Just a toolbar icon and a fast path from "I see a bug" to "the issue is filed."

shot2issue is an open-source Chrome extension (Manifest V3), written in TypeScript and entirely client-side. You build it and load `build/` — that's it.

<p align="center">
  <img src="src/icons/icon128.png" width="96" alt="shot2issue icon" />
</p>

## Screenshots

Toolbar popup — pick a capture source (each shows its shortcut when set):

![Popup](docs/screenshots/popup.png)

Editor — annotate the screenshot and submit:

![Editor](docs/screenshots/editor.png)

Settings — accounts and workspaces, organized into tabs:

![Settings](docs/screenshots/options.png)

AI assistant — sign in with a ChatGPT subscription to write titles and bodies:

![AI assistant](docs/screenshots/ai.png)

## Why shot2issue

- **No GitHub token, ever.** Files GitHub issues using your existing github.com session — no Personal Access Token to create, scope, rotate, or store.
- **From bug to issue in seconds.** Click the icon, mark up the screenshot, type a line, submit. The image lands inline in the issue, not as a stray attachment link.
- **Capture anything.** The current tab, your whole screen, a specific window, another app, or an image pasted straight from the clipboard.
- **Annotate without a separate tool.** Boxes, arrows, numbered callouts, freehand pen, text, and a mosaic to redact secrets — all on a canvas in the editor.
- **Local-only by design.** No server, no analytics. Settings live in `chrome.storage.local` and never leave your browser unless you export them.

## Features

- **Capture from anywhere.** Grab the current tab, or — via the toolbar popup — your whole screen, a specific window, or another application (`chrome.desktopCapture`). You can also paste an image straight in: use **Paste from clipboard** in the popup, or Ctrl/Cmd+V inside the editor. Each capture source can have its own keyboard shortcut, shown in the popup when set.
- **Multiple screenshots per issue.** Every capture adds a thumbnail; annotate each one, switch between them, and delete any. All of them are attached on submit. Re-clicking the icon (or pasting again) while the editor is open adds to the same issue.
- **Full annotation toolkit.** Rectangle, numbered box (auto-incrementing badge), arrow, freehand pen, resizable auto-wrapping text, and a mosaic to redact sensitive content. Undo with Ctrl/Cmd+Z; press Esc twice to close the editor.
- **Keep the image.** Download the annotated PNG or copy it straight to the clipboard.
- **Three issue trackers.** GitHub (no token — uses your github.com session), GitLab (REST API + a PAT with `api` scope; self-hosted supported), and YouTrack (REST API + a permanent token).
- **Workspaces and shared accounts.** Each **workspace** points at one repo/project. Reusable **Accounts** hold YouTrack/GitLab credentials and are shared across workspaces, so you configure a credential once. (GitHub needs no account.)
- **Optional AI assistant.** Sign in with an OpenAI Codex / ChatGPT subscription (OAuth, no pay-per-use API key). **Summarize title** writes an issue title from your description plus the screenshots. **Smart dictation** lets you type or dictate (speech transcribed via your subscription) and the model writes the title and a Markdown body, referencing the numbered boxes in your screenshot. Prompts are editable, with restore-to-default; the model list is fetched live.
- **Templates and placeholders.** Default title and body templates support `{pageTitle}`, `{pageUrl}`, and `{type}` so every issue starts pre-filled.
- **Localized.** Interface in English, Simplified Chinese, and Japanese — auto-detected from your system on first run, switchable in Settings.
- **Portable settings.** Export and import your configuration as JSON.

## Quickstart

The extension is TypeScript and must be built before it can be loaded.

```bash
git clone https://github.com/wa-otomia/shot2issue
cd shot2issue
npm install
npm run build      # compiles TypeScript and copies assets into build/
```

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the **`build/`** directory (not the repo root, not `src/`).
4. The options page opens on first install — add at least one workspace.

To iterate, run `npm run watch` to recompile on every change, then hit **Reload** on the extension card in `chrome://extensions`. Settings survive reloads; removing the extension clears them.

## Usage

1. Open the page you want to capture and click the shot2issue toolbar icon — or pick a capture source from the popup. The editor opens in a new tab.
2. Choose a workspace and type, annotate the screenshot(s), and edit the title and description. The title defaults to the page title plus the selected type; the body is prefilled with the page URL. (Optionally let the AI assistant write them.)
3. Click **Submit issue**. The screenshot is attached and rendered inline, and you get a link to the new issue.

If something goes wrong, **Download PNG** saves the annotated image to attach manually, and **Submit without screenshot** files the issue without the image.

## Issue targets

Each tracker is configured as one or more **workspaces** in Settings. YouTrack and GitLab credentials live on reusable **Accounts** that workspaces share.

| Target | Auth | Notes |
| --- | --- | --- |
| **GitHub** | Your existing github.com session | No Personal Access Token. Set owner (user/org) and repository. |
| **GitLab** | Account PAT with `api` scope | REST API. Self-hosted supported via the account's base URL. Project is the numeric id or `group/project` path. |
| **YouTrack** | Account permanent token | REST API. Set the instance base URL and project short name/id. |

Settings are organized into tabs: **Workspaces**, **Accounts**, **AI**, **General**, and **Language**.

## How it works

- **GitHub** — shot2issue files the issue through your existing github.com session, so the screenshot uploads as a genuine inline attachment and renders correctly even in private repositories. No token to create or store.
- **GitLab / YouTrack** — shot2issue talks to the documented REST API with your token: it uploads each screenshot and creates the issue with the image embedded inline. The first submission to a new instance prompts Chrome for permission to access that origin (instance URLs aren't known in advance).

## AI assistant (optional)

The AI assistant is off until you connect it. Sign in with an OpenAI Codex / ChatGPT-subscription account (OAuth) — it uses your subscription, not a pay-per-use API key.

- **Summarize title** generates an issue title from the current type, page title, page URL, your description, and the screenshot.
- **Smart dictation** opens a dialog where you type or dictate a description (recording is transcribed via your subscription). The model then writes a title and a Markdown body from your text, the screenshots, and the page metadata — referencing any numbered boxes in the image.

Both prompts are editable in Settings, each with a **Restore default prompt** button, and the model list is fetched live. The assistant talks to OpenAI/ChatGPT endpoints and is subject to OpenAI's terms for your account. Its tokens are stored in `chrome.storage.local` only and are **never** included in settings exports.

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Granted when you click the icon; used to capture the visible tab and read its title and URL. |
| `storage` | Stores settings and the pending screenshots in `chrome.storage.local`. |
| `unlimitedStorage` | Lets full-screen / multi-image captures be staged without hitting the small session-storage quota. Staged images are cleared after submit and when the editor closes. |
| `scripting` | Files the issue on github.com via your session, and runs the frame-grab script in the active tab for screen/window capture. |
| `desktopCapture` | Shows the screen/window picker when you capture the screen, a window, or another app. Used only for that capture source. |
| `clipboardRead` | Reads an image from the clipboard for **Paste from clipboard** and the editor's paste. |
| `notifications` | Shows a system notification when a capture fails (including screen capture). |

Host permissions are limited to `https://github.com/*` by default — the only origin the extension contacts out of the box. YouTrack and GitLab instance URLs aren't known in advance, so they're requested at runtime: the first time you save or submit to an instance, Chrome asks permission for that specific origin. The AI assistant similarly requests `https://auth.openai.com/*`, `https://chatgpt.com/*`, and `http://localhost:1455/*` when you connect it.

## Privacy

- **Minimal data.** Only the screenshot, title, description, and the current page URL are used. shot2issue collects no console output, network activity, device information, or telemetry.
- **No GitHub token.** GitHub uses your existing web session — no token or secret is created or stored.
- **Tokens stay local.** YouTrack/GitLab tokens and the AI assistant's tokens are stored only in `chrome.storage.local`. AI tokens are excluded from settings exports.
- **Attachment visibility follows the repo.** Attachments in private repositories require sign-in to view; attachments in public repositories are visible anonymously. Choose the target repository accordingly.
- **Built-in redaction.** The mosaic tool pixelates a region of the original screenshot — cover sensitive content before you submit.

## Building a release archive

You can also build the distributable zip with Docker, no local toolchain required:

```bash
docker build --target export --output type=local,dest=dist .
# Output: dist/shot2issue-<version>.zip
```

CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) runs the Docker build on every push to `main`, on pull requests, and on manual runs, uploading the archive as a workflow artifact. Pushing a `v*` tag also attaches the archive to a GitHub release.

## Project structure

`src/` holds the TypeScript sources and static assets. The build compiles them into `build/`, which is the **Load unpacked** target; `dist/` holds the packaged release zip.

```
shot2issue/
├── src/                  # TypeScript sources + static assets
│   ├── manifest.json     # MV3 manifest
│   ├── background.ts     # service worker: capture on icon/shortcut, open editor
│   ├── editor.*          # main UI: capture, canvas annotation, submission
│   ├── options.*         # settings: workspaces, accounts, AI, general, language
│   └── lib/              # storage, i18n, and providers/ (GitHub / GitLab / YouTrack)
├── scripts/              # asset-copy build step
├── build/                # compiled output — the Load unpacked target (generated)
├── dist/                 # packaged release zip (generated)
└── Dockerfile            # Docker build for the release archive
```

## Adding an issue backend

Each tracker is a provider. To add one, implement the `Provider` interface from [`src/lib/providers/types.ts`](src/lib/providers/types.ts) in a new module under `src/lib/providers/`, then register it in [`src/lib/providers/index.ts`](src/lib/providers/index.ts). The provider declares its configuration fields, validates a workspace, requests any host permissions it needs, and implements `submit()`; the editor and options pages pick it up from the registry.

## Limitations

- Captures the visible area only — no full-page or scrolling capture.
- Restricted pages such as `chrome://` and the Chrome Web Store cannot be captured; the editor tells you when.
- Labels are not set automatically.

## License

[MIT](LICENSE)
