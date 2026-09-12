#!/usr/bin/env bash
#
# Mesa — one-command setup & launch (macOS / Linux).
#
# Assumes NOTHING is installed. This script brings a clean machine all the way
# to a running Mesa desktop app, installing every missing dependency LOCALLY to
# your user account wherever possible (no surprise system changes):
#   • Xcode Command Line Tools (macOS only) — C compiler + git
#   • System libraries Tauri needs (Linux only, via your package manager — sudo)
#   • Node.js LTS -> ~/.nvm                 (via nvm, user-only)
#   • Rust        -> ~/.cargo and ~/.rustup (via rustup, user-only)
#   • JS deps     -> ./node_modules          (local to this project)
# Then it launches the real Tauri desktop app.
#
# Run it with:   bash run.sh
#
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
info() { printf "  • %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

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
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
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
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  . "$HOME/.cargo/env"
fi
ok "Rust $(cargo --version | awk '{print $2}')"

# ─────────────────────────────────────────────────────────────────────────────
# 4) JavaScript dependencies (local to ./node_modules).
# ─────────────────────────────────────────────────────────────────────────────
info "Installing JS dependencies (npm install)…"
npm install
ok "JS dependencies installed"

# 4b) Guard against a stale Rust build cache. Cargo and Tauri bake this folder's
# ABSOLUTE path into src-tauri/target (and the generated permissions in
# src-tauri/gen). If the project was moved or renamed since the last build, those
# paths point at the old location and the build fails reading generated files.
# We stamp the path we built at; if it no longer matches, clear the cache once so
# it recompiles cleanly. (Unchanged path → no clean → fast incremental builds.)
STAMP="src-tauri/.build-cache-path"
HERE="$(pwd)"
if [ -d src-tauri/target ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$HERE" ]; then
  info "Project folder moved since the last build — clearing the stale Rust cache (one-time)…"
  rm -rf src-tauri/target src-tauri/gen
  ok "Stale build cache cleared (this run recompiles from scratch)"
fi
printf '%s' "$HERE" > "$STAMP"

# ─────────────────────────────────────────────────────────────────────────────
# 5) Launch the real desktop app.
# ─────────────────────────────────────────────────────────────────────────────
bold "▶ Launching Mesa — the FIRST run compiles Rust, so give it a few minutes."
bold "  The app window opens automatically when the build finishes."
exec npm run mesa
