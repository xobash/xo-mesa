#!/usr/bin/env bash
# Pinned user-local Node for macOS/Linux source launches. Source it after
# bootstrap-download.sh, then call mesa_ensure_node. It never modifies nvm.
# Digests are the official SHASUMS256.txt entries for the exact .node-version.
mesa_node_digest() {
  case "$1" in
    darwin-arm64) printf '0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207' ;;
    darwin-x64) printf '45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec' ;;
    linux-arm64) printf 'cc8bc82b2dd0b595c3b95a4c3c9c8c350907cff011afbdee3d1379e812e1e3e3' ;;
    linux-x64) printf 'c7a10d6816da8eaaa7534dd73c71c6e2b2c391dbbf845e364902d156615dd1b8' ;;
    *) return 1 ;;
  esac
}

mesa_node_folder() {
  if [ "$(uname)" = "Darwin" ]; then printf '%s/Library/Application Support/Mesa/toolchains' "$HOME"
  else printf '%s/mesa/toolchains' "${XDG_DATA_HOME:-$HOME/.local/share}"; fi
}

mesa_ensure_node() {
  local version="$1" platform digest folder name destination stage
  [ "$version" = "22.22.3" ] || { printf "Update reviewed Node digests when changing the toolchain.\n" >&2; return 1; }
  # Keep a Node already on PATH only when it is exactly the pin.
  if [ "$(node -v 2>/dev/null || true)" = "v$version" ] && command -v npm >/dev/null 2>&1; then return 0; fi
  # Reuse an nvm-managed copy of the pin by path; nvm itself is neither sourced nor changed.
  local nvm_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v$version/bin"
  if [ "$("$nvm_bin/node" -v 2>/dev/null || true)" = "v$version" ] && [ -x "$nvm_bin/npm" ]; then
    export PATH="$nvm_bin:$PATH"; return 0
  fi
  case "$(uname):$(uname -m)" in
    Darwin:arm64) platform=darwin-arm64 ;;
    Darwin:x86_64) platform=darwin-x64 ;;
    Linux:x86_64) platform=linux-x64 ;;
    Linux:aarch64|Linux:arm64) platform=linux-arm64 ;;
    *) printf "No verified Node bootstrap for this architecture.\n" >&2; return 1 ;;
  esac
  digest="$(mesa_node_digest "$platform")"
  folder="$(mesa_node_folder)"
  name="node-v$version-$platform"
  destination="$folder/$name"
  # Reuse a verified earlier install, so a relaunch works offline.
  if [ "$("$destination/bin/node" -v 2>/dev/null || true)" != "v$version" ]; then
    printf "  • Installing pinned Node.js %s into %s…\n" "$version" "$folder"
    mkdir -p "$folder"
    stage="$(mktemp -d "$folder/.stage.XXXXXX")" || return 1
    # .tar.gz needs only tar and gzip; minimal Linux systems can lack xz.
    if ! bootstrap_download "https://nodejs.org/dist/v$version/$name.tar.gz" "$digest" "$stage/node.tar.gz" \
      || ! tar -xzf "$stage/node.tar.gz" -C "$stage" \
      || [ ! -d "$stage/$name" ]; then
      rm -rf "$stage"; printf "Pinned Node.js could not be installed.\n" >&2; return 1
    fi
    rm -rf "$destination"
    mv "$stage/$name" "$destination"
    rm -rf "$stage"
  fi
  export PATH="$destination/bin:$PATH"
  [ "$(node -v 2>/dev/null || true)" = "v$version" ] || { printf "Pinned Node.js cannot run.\n" >&2; return 1; }
}
