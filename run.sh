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
    if command -v apt >/dev/null 2>&1; then
      info "Installing Tauri's system libraries via apt (needs sudo)…"
      sudo apt update
      sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
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
      err "Couldn't detect apt, pacman, or dnf."
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
# 2) Node.js LTS — installed user-only via nvm if npm isn't already on PATH.
# ─────────────────────────────────────────────────────────────────────────────
# Load an existing nvm if the user has one, so we can see a node it manages.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! command -v npm >/dev/null 2>&1; then
  info "Node.js not found — installing the LTS locally via nvm (user-only)…"
  mkdir -p "$NVM_DIR"
  bootstrap_download https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/nvm.sh cd6f374433a22ec01919a834cf59d03e0ba07c226bed460a50ef5eecc38c39ef "$NVM_DIR/nvm.sh"
  bootstrap_download https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/nvm-exec f3b7c71ac96ca4f2f75871af20070c3063d1e3fcdc44019af0635c95112e9e76 "$NVM_DIR/nvm-exec"
  chmod 700 "$NVM_DIR/nvm-exec"
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
fi
ok "Node $(node -v), npm $(npm -v)"

# ─────────────────────────────────────────────────────────────────────────────
# 3) Rust — installed user-only via rustup if cargo isn't already on PATH.
# ─────────────────────────────────────────────────────────────────────────────
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
if ! command -v cargo >/dev/null 2>&1; then
  info "Installing Rust locally via rustup (user-only, no sudo)…"
  case "$OS:$(uname -m)" in
    Darwin:arm64) rust_target=aarch64-apple-darwin; rust_hash=20ef5516c31b1ac2290084199ba77dbbcaa1406c45c1d978ca68558ef5964ef5 ;;
    Darwin:x86_64) rust_target=x86_64-apple-darwin; rust_hash=9c331076f62b4d0edeae63d9d1c9442d5fe39b37b05025ec8d41c5ed35486496 ;;
    Linux:x86_64) rust_target=x86_64-unknown-linux-gnu; rust_hash=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c ;;
    Linux:aarch64) rust_target=aarch64-unknown-linux-gnu; rust_hash=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c ;;
    *) err "No verified Rust bootstrap for this architecture."; exit 1 ;;
  esac
  rust_init="$(mktemp)"
  bootstrap_download "https://static.rust-lang.org/rustup/archive/1.28.2/$rust_target/rustup-init" "$rust_hash" "$rust_init"
  chmod 700 "$rust_init"
  "$rust_init" -y --no-modify-path
  rm -f "$rust_init"
  . "$HOME/.cargo/env"
fi
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
# 5) Build and launch the optimized desktop app.
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
