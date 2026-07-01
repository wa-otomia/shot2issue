# Releasing the desktop app

The desktop app ships from `desktop-v*` tags via
`.github/workflows/desktop-release.yml`, independent of the extension's `v*`
tags (handled by `.github/workflows/build.yml`).

## Steps

1. Bump the version in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, and the
   `shot2issue` entry in `apps/desktop/src-tauri/Cargo.lock`.
2. Tag and push:
   ```sh
   git tag desktop-vX.Y.Z
   git push origin desktop-vX.Y.Z
   ```
3. CI builds + signs macOS / Windows / Linux and creates a **draft** GitHub
   Release with installers + `latest.json` + minisign `.sig` files.
4. Review the draft (download + smoke-test the installers), then publish:
   ```sh
   gh release edit desktop-vX.Y.Z --draft=false
   ```

## Auto-update wiring — don't hand-manage the Latest badge

The updater endpoint baked into every binary (tauri.conf.json) is a FIXED
rolling release, NOT the repo Latest:

    https://github.com/wa-otomia/shot2issue/releases/download/desktop-latest/latest.json

Publishing a `desktop-v*` release fires
`.github/workflows/desktop-updater-channel.yml`, which:

- mirrors that release's `latest.json` onto the `desktop-latest` rolling release
  (a prerelease, so it never grabs the repo Latest badge), and
- marks the `desktop-v*` release as the repo **Latest**.

Why both are needed:

- **New clients (>= v0.1.2)** poll the fixed `desktop-latest` URL, so an
  extension `v*` release can never break their updates.
- **Legacy clients (<= v0.1.1)** have `/releases/latest/download/latest.json`
  baked in, so they need the desktop release to hold the repo Latest badge. The
  workflow keeps that true until those versions age out.

So after publishing you normally do **nothing** for updates — CI handles it.

### If updates ever 404

Check what each endpoint actually serves (both should report the newest desktop
version):

```sh
curl -sL https://github.com/wa-otomia/shot2issue/releases/download/desktop-latest/latest.json | jq .version   # new clients
curl -sL https://github.com/wa-otomia/shot2issue/releases/latest/download/latest.json          | jq .version   # legacy clients
```

If the legacy one is wrong, an extension release stole the Latest badge —
re-assert it (`gh release edit --latest=false` is silently ignored, so use the
API):

```sh
RID=$(gh api repos/wa-otomia/shot2issue/releases --jq 'map(select(.tag_name|test("^desktop-v")))|sort_by(.created_at)|last|.id')
gh api -X PATCH repos/wa-otomia/shot2issue/releases/$RID -f make_latest=true
```
