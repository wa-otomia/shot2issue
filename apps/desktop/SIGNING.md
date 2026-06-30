# Signing & Auto-Update — shot2issue (desktop)

Two *independent* signatures are involved. Don't conflate them:

| Signature | Purpose | Required? | Tooling |
|-----------|---------|-----------|---------|
| **minisign updater signature** | Proves an update artifact is authentic before the app installs it. Verified against the `pubkey` baked into `tauri.conf.json`. | **Yes** | `tauri signer` |
| **macOS code signature (self-signed)** | Gives the `.app` a *stable* code identity so macOS keeps the Screen Recording (TCC) grant across updates. NOT notarization. | Recommended for mac | `security` / `codesign` |
| Windows Authenticode / Linux GPG | OS-level installer trust (SmartScreen / repo signing). | Optional | `signtool` / `gpg` |

The release flow lives in `.github/workflows/desktop-release.yml` and fires on
`desktop-v*` tags only — completely separate from the extension's `v*`
`build.yml`. Both release from the same repo without colliding.

---

## 1. Minisign updater keypair (REQUIRED)

Generate once on a trusted machine:

```bash
npm --prefix apps/desktop run tauri signer generate -- -w ~/.tauri/shot2issue.key
# → prompts for a password; writes:
#   ~/.tauri/shot2issue.key      (PRIVATE — never commit)
#   ~/.tauri/shot2issue.key.pub  (PUBLIC  — paste into tauri.conf.json)
```

- Copy the **contents** of `~/.tauri/shot2issue.key.pub` into
  `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
  (replacing the `REPLACE_WITH_MINISIGN_PUBKEY` placeholder). **The updater
  rejects every update until this is the real key.**
- Put the **contents** of `~/.tauri/shot2issue.key` into the GitHub secret
  `TAURI_SIGNING_PRIVATE_KEY`, and the password into
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

CI signs each updater artifact with this key (`tauri-action` reads the two env
vars) and `includeUpdaterJson: true` emits `latest.json` next to the binaries.

## 2. macOS self-signed code-signing cert (recommended, NO notarization)

> Why: macOS ties the **Screen Recording** TCC grant to the app's code
> signature. An *unsigned* (ad-hoc) app gets a new transient identity on every
> build, so the user must re-grant Screen Recording after **every** update. A
> stable self-signed identity keeps the grant. We deliberately skip Apple
> notarization (no paid Developer ID); users do a one-time right-click → Open /
> System Settings → Privacy → Screen Recording grant on first launch.

Create the cert in **Keychain Access** (one-time, on a Mac):

```
Keychain Access → Certificate Assistant → Create a Certificate…
  Name:             shot2issue Self-Signed
  Identity Type:    Self Signed Root
  Certificate Type: Code Signing
```

or fully scripted:

```bash
# 1) Cert config
cat > s2i-codesign.cnf <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = shot2issue Self-Signed
[ v3 ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

# 2) Key + self-signed cert
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -config s2i-codesign.cnf

# 3) Bundle into a .p12 (set a strong export password)
openssl pkcs12 -export -inkey key.pem -in cert.pem \
  -name "shot2issue Self-Signed" -out s2i-codesign.p12

# 4) The signing identity string is the certificate CN:
#    APPLE_SIGNING_IDENTITY = "shot2issue Self-Signed"
```

Base64-encode the `.p12` for the GitHub secret:

```bash
base64 -i s2i-codesign.p12 | pbcopy   # → paste into APPLE_CERTIFICATE
```

First launch on a user's Mac: System Settings → Privacy & Security → Screen
Recording → enable shot2issue, then quit & reopen (TCC requires a restart).
Because the identity is stable, this is needed once, not per update.

## 3. Windows / Linux (optional placeholders)

The workflow has `Sign Windows installers (placeholder)` and `Sign Linux
packages (placeholder)` steps that **skip automatically** when their secrets are
absent. To enable Windows Authenticode later, prefer wiring
`bundle.windows.signCommand` in `tauri.conf.json` so signing runs before
`latest.json` hashing.

---

## 4. Complete GitHub secrets list

| Secret | Required | Used by | Notes |
|--------|----------|---------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | **Yes** | updater signing (all platforms) | contents of `~/.tauri/shot2issue.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **Yes** | updater signing | password set during `tauri signer generate` |
| `APPLE_CERTIFICATE` | mac only | keychain import | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | mac only | keychain import | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | mac only | `codesign` identity selection | the cert CN, e.g. `shot2issue Self-Signed` |
| `WINDOWS_CERTIFICATE` | optional | signtool placeholder | base64 of `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | optional | signtool placeholder | |
| `LINUX_GPG_PRIVATE_KEY` | optional | gpg placeholder | armored private key |
| `LINUX_GPG_PASSPHRASE` | optional | gpg placeholder | |
| `GITHUB_TOKEN` | auto | release upload | provided by Actions |

## 5. Cutting a release

```bash
# bump apps/desktop/package.json + apps/desktop/src-tauri/tauri.conf.json version, commit, then:
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

This runs `desktop-release.yml`, produces signed installers + `latest.json`, and
opens a **draft** GitHub release. Review the assets, then publish. The `latest`
release's `latest.json` is what the updater endpoint resolves to.
