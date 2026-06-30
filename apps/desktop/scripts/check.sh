#!/usr/bin/env bash
# Run the backend `cargo check` the same way CI does, inside a rust:bookworm
# Docker container with the Linux system libs the Tauri + xcap stack needs.
# This box has no host Rust/system-libs; Docker is the only way to type-check
# the Rust side. (Curvault's scripts/check.sh is the template; this adds the
# capture-stack deps: xcap 0.9.6 pulls pipewire/dbus/xcb + needs libclang.)
set -euo pipefail

cd "$(dirname "$0")/.."

# A named volume keeps the cargo registry + target cache between runs so repeat
# checks are fast (first run downloads the crate index + compiles deps).
CACHE_VOL="${CARGO_CACHE_VOL:-shot2issue-desktop-cargo}"

echo "==> Backend: cargo check (rust:bookworm in Docker)"
docker run --rm \
    -v "$PWD/src-tauri:/work" \
    -v "${CACHE_VOL}-registry:/usr/local/cargo/registry" \
    -v "${CACHE_VOL}-target:/work/target" \
    -w /work \
    rust:bookworm bash -c '
    set -euo pipefail
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        pkg-config \
        libgtk-3-dev \
        libwebkit2gtk-4.1-dev \
        librsvg2-dev \
        libsoup-3.0-dev \
        libayatana-appindicator3-dev \
        libssl-dev \
        libxcb1-dev libxcb-randr0-dev libxcb-shm0-dev libxcb-xfixes0-dev \
        libdbus-1-dev \
        libpipewire-0.3-dev \
        clang libclang-dev \
        patchelf > /dev/null
    cargo check --all-targets
'

echo
echo "Backend check passed."
