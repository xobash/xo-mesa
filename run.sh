#!/usr/bin/env bash
# Mesa setup and launch for macOS/Linux. Installs missing prerequisites,
# using user-local installs where supported; Linux system libraries require sudo.
# Run from this folder with: bash run.sh
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
info() { printf "  • %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

source scripts/bootstrap-download.sh

bold "▶ Mesa — setup & launch"

OS="$(uname)"

# ─────────────────────────────────────────────────────────────────────────────
# 1) Platform build prerequisites (C toolchain + Tauri's system libraries).
# ─────────────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  # macOS: Xcode Command Line Tools provide the C compiler AND git.
  if ! xcode-select -p >/dev/null 2>&1; then
    info "Installing Xcode Command Line Tools (a macOS dialog will pop up)…"
    xcode-select --install || true
    err  "Finish that install in the dialog, then run 'bash run.sh' again."
    exit 1
  fi
  ok "Xcode Command Line Tools present"

elif [ "$OS" = "Linux" ]; then
  # Linux: install WebKitGTK 4.1 + build toolchain via the detected package
  # manager. This is the one step that needs sudo.
  need_libs() { ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; }
  if need_libs; then
    if command -v apt-get >/dev/null 2>&1; then
      info "Installing Tauri's system libraries via apt-get (needs sudo)…"
      sudo apt-get update
      sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
        libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev git
    elif command -v pacman >/dev/null 2>&1; then
      info "Installing Tauri's system libraries via pacman (needs sudo)…"
      sudo pacman -S --needed --noconfirm webkit2gtk-4.1 base-devel curl wget file \
        openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool git
    elif command -v dnf >/dev/null 2>&1; then
      info "Installing Tauri's system libraries via dnf (needs sudo)…"
      sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
        libappindicator-gtk3-devel librsvg2-devel libxdo-devel git
      sudo dnf group install -y "c-development" || sudo dnf groupinstall -y "Development Tools" || true
    else
      err "Couldn't detect apt-get, pacman, or dnf."
      info "Install these manually, then re-run: WebKitGTK 4.1 dev headers, a C"
      info "toolchain (gcc/make), git, curl, wget, openssl dev, librsvg, libxdo,"
      info "and libayatana-appindicator3 dev."
      exit 1
    fi
  fi
  ok "System libraries present"
else
  err "Unsupported OS '$OS'. Use run.cmd on Windows, or install deps manually."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2) Pinned Node.js (.node-version) — the official archive, digest-verified,
#    unpacked user-only. An existing Node is kept only if it is exactly the pin.
# ─────────────────────────────────────────────────────────────────────────────
source scripts/posix-node.sh
MESA_NODE_VERSION="$(cat .node-version)"
mesa_ensure_node "$MESA_NODE_VERSION" || { err "Pinned Node version is unavailable."; exit 1; }
ok "Node $(node -v), npm $(npm -v)"

# ─────────────────────────────────────────────────────────────────────────────
# 3) Rust — the rust-toolchain.toml pin. rustup is installed user-only when
#    Rust is missing, or when a Rust without rustup is not exactly the pin.
# ─────────────────────────────────────────────────────────────────────────────
source scripts/posix-rust.sh
MESA_RUST_VERSION="$(sed -n 's/^channel = "\([^"]*\)"$/\1/p' rust-toolchain.toml)"
mesa_ensure_rust "$MESA_RUST_VERSION" || { err "Rust $MESA_RUST_VERSION is unavailable."; exit 1; }
ok "Rust $(cargo --version | awk '{print $2}')"

# Invalidate generated native caches when the checkout path changes.
STAMP="src-tauri/.build-cache-path"
HERE="$(pwd)"
if [ -d src-tauri/target ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$HERE" ]; then
  info "Project folder moved since the last build — clearing the stale Rust cache (one-time)…"
  rm -rf src-tauri/target src-tauri/gen
  ok "Stale build cache cleared (this run recompiles from scratch)"
fi
printf '%s' "$HERE" > "$STAMP"

if node scripts/launch-cache.mjs check-deps; then
  ok "JS dependencies are current"
else
  info "Installing JS dependencies (npm ci)…"
  npm ci
  node scripts/launch-cache.mjs stamp-deps
  ok "JS dependencies installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4) Build and launch the optimized desktop app.
# ─────────────────────────────────────────────────────────────────────────────
if node scripts/launch-cache.mjs check-build; then
  ok "Mesa build is current"
else
  bold "▶ Building Mesa — the first source build can take several minutes."
  if [ "$OS" = "Darwin" ]; then
    npm run mesa:build -- --bundles app
  else
    npm run mesa:build -- --no-bundle
  fi
  node scripts/launch-cache.mjs stamp-build
fi
if [ "$OS" = "Darwin" ]; then
  APP="src-tauri/target/release/bundle/macos/Mesa.app"
  if [ ! -d "$APP" ]; then err "Release app was not built."; exit 1; fi
  open -a "$APP"
else
  APP="src-tauri/target/release/mesa"
  if [ ! -x "$APP" ]; then err "Release app was not built."; exit 1; fi
  exec "$APP"
fi
