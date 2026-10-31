#!/usr/bin/env bash
# Pinned user-local Rust for macOS/Linux source launches. Source it after
# bootstrap-download.sh, then call mesa_ensure_rust. A system Rust is never
# removed; rustup's ~/.cargo/bin goes first on PATH and reads rust-toolchain.toml.
# Digests are the reviewed rustup-init 1.28.2 binaries.
mesa_rustup_target() {
  case "$(uname):$(uname -m)" in
    Darwin:arm64) printf 'aarch64-apple-darwin 20ef5516c31b1ac2290084199ba77dbbcaa1406c45c1d978ca68558ef5964ef5' ;;
    Darwin:x86_64) printf 'x86_64-apple-darwin 9c331076f62b4d0edeae63d9d1c9442d5fe39b37b05025ec8d41c5ed35486496' ;;
    Linux:x86_64) printf 'x86_64-unknown-linux-gnu 20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c' ;;
    Linux:aarch64) printf 'aarch64-unknown-linux-gnu e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c' ;;
    *) return 1 ;;
  esac
}

mesa_ensure_rust() {
  local version="$1" found spec rust_init
  if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
  if command -v cargo >/dev/null 2>&1; then
    command -v rustup >/dev/null 2>&1 && return 0
    # Without rustup, rust-toolchain.toml is ignored: the installed compiler must be the pin.
    found="$(rustc --version 2>/dev/null | awk '{print $2}' || true)"
    [ "$found" = "$version" ] && return 0
    printf "Found Rust %s without rustup; installing rustup for Rust %s. The system Rust stays installed.\n" "${found:-unknown}" "$version" >&2
  else
    printf "Installing Rust %s locally via rustup (user-only, no sudo).\n" "$version" >&2
  fi
  spec="$(mesa_rustup_target)" || { printf "No verified Rust bootstrap for this architecture.\n" >&2; return 1; }
  rust_init="$(mktemp)"
  bootstrap_download "https://static.rust-lang.org/rustup/archive/1.28.2/${spec% *}/rustup-init" "${spec#* }" "$rust_init" || { rm -f "$rust_init"; return 1; }
  chmod 700 "$rust_init"
  RUSTUP_INIT_SKIP_PATH_CHECK=yes "$rust_init" -y --no-modify-path --default-toolchain "$version" || { rm -f "$rust_init"; return 1; }
  rm -f "$rust_init"
  . "$HOME/.cargo/env"
}
