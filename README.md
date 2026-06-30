# shot2issue

Monorepo for **shot2issue** — capture a screenshot, annotate it, and file it as a GitHub / GitLab / YouTrack issue with the image inline.

| Package | What it is |
|---|---|
| [apps/extension](apps/extension/README.md) | The Chrome (MV3) browser extension — capture the current tab. Localized: [中文](apps/extension/README.zh-CN.md) · [日本語](apps/extension/README.ja.md). |
| [apps/desktop](apps/desktop/README.md) | The cross-platform desktop app (Tauri 2) — a global hotkey captures any window/region system-wide. *(work in progress)* |
| `packages/core` | Shared TypeScript core: the canvas annotation engine, issue providers, and AI/OAuth helpers used by both apps. |

## Releases

- **Extension** — tag `v*` → built by [`.github/workflows/build.yml`](.github/workflows/build.yml) (Docker), zip attached to the GitHub Release.
- **Desktop** — tag `desktop-v*` → built & signed by `.github/workflows/desktop-release.yml`, with in-app auto-update.

Licensed under MIT.
