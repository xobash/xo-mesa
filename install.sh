#!/usr/bin/env bash

set -euo pipefail

repo_url="https://github.com/xobash/xo-mesa.git"
release_version="${MESA_VERSION:-v0.1.0}"
[[ "$release_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { printf "Invalid Mesa release version\n" >&2; exit 1; }
current_dir="$(pwd -P)"

if [[ -n "${MESA_DIR:-}" ]]; then
  install_dir="$(cd "${MESA_DIR}" 2>/dev/null && pwd -P || printf '%s\n' "${MESA_DIR}")"
elif [[ "$(basename "${current_dir}")" == "xo-mesa" && -d "${current_dir}/.git" ]]; then
  install_dir="${current_dir}"
else
  install_dir="${current_dir}/xo-mesa"
fi

info() {
  printf '%s\n' "$1"
}

fail() {
  printf 'Mesa install failed: %s\n' "$1" >&2
  exit 1
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi

  case "$(uname)" in
    Darwin)
      info "Git is missing. Opening the Xcode Command Line Tools installer..."
      xcode-select --install || true
      fail "Finish the macOS Command Line Tools install, then rerun the Mesa install command."
      ;;
    Linux)
      if command -v apt >/dev/null 2>&1; then
        info "Git is missing. Installing it with apt (needs sudo)..."
        sudo apt update
        sudo apt install -y git
      elif command -v pacman >/dev/null 2>&1; then
        info "Git is missing. Installing it with pacman (needs sudo)..."
        sudo pacman -S --needed --noconfirm git
      elif command -v dnf >/dev/null 2>&1; then
        info "Git is missing. Installing it with dnf (needs sudo)..."
        sudo dnf install -y git
      else
        fail "Git is required, and Mesa could not detect apt, pacman, or dnf to install it automatically."
      fi
      ;;
    *)
      fail "Unsupported OS. On Windows, use install.ps1 (see README), or install Mesa manually."
      ;;
  esac

  if ! command -v git >/dev/null 2>&1; then
    fail "Git is still unavailable in this shell. Open a new terminal and rerun the Mesa install command."
  fi
}

ensure_git

if [[ -d "${install_dir}/.git" ]]; then
  info "Updating Mesa in ${install_dir}..."
  origin_url="$(git -C "${install_dir}" remote get-url origin)" || fail "Could not inspect origin. No update applied; use MESA_DIR to a new empty folder if recovery is needed."
  [[ "$origin_url" == "$repo_url" || "$origin_url" == "git@github.com:xobash/xo-mesa.git" ]] || fail "Unexpected origin. No code was executed."
  git -C "${install_dir}" fetch --no-tags origin "refs/tags/$release_version:refs/tags/$release_version"
  git -C "${install_dir}" verify-tag "$release_version" || fail "The release tag signature cannot be verified with your trusted signing keys. No code was executed."
  if ! git -C "${install_dir}" merge --ff-only "refs/tags/$release_version"; then
    fail "Mesa could not fast-forward this checkout. Your local files remain in ${install_dir}. If this checkout predates the public repository reset, set MESA_DIR to a new empty folder and rerun the installer; copy any work you want to keep from the old folder after reviewing it."
  fi
elif [[ -e "${install_dir}" ]]; then
  fail "The target folder exists but is not a Git checkout: ${install_dir}. Move it aside or set MESA_DIR to another folder."
else
  info "Cloning Mesa into ${install_dir}..."
  git clone --branch "$release_version" --single-branch "${repo_url}" "${install_dir}"
  git -C "${install_dir}" verify-tag "$release_version" || fail "The release tag signature cannot be verified with your trusted signing keys. No code was executed."
fi

installed_commit="$(git -C "$install_dir" rev-parse HEAD)" || fail "Could not inspect installed commit."
release_commit="$(git -C "$install_dir" rev-parse "refs/tags/$release_version^{commit}")" || fail "Could not inspect signed release commit."
[[ "$installed_commit" == "$release_commit" ]] || fail "This checkout is ahead of the requested release. Nothing was reset; use MESA_DIR to a new empty folder."
cd "${install_dir}"
exec bash ./run.sh
