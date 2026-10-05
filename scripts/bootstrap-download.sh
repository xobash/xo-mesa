#!/usr/bin/env bash
set -euo pipefail
# Download to a private temporary file and verify reviewed bytes before use.
bootstrap_download() {
  local url="$1" digest="$2" destination="$3" temporary actual
  temporary="$(mktemp)"
  if ! curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$temporary"; then rm -f "$temporary"; return 1; fi
  if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$temporary" | awk '{print $1}')"
  else actual="$(sha256sum "$temporary" | awk '{print $1}')"; fi
  if [ "$actual" != "$digest" ]; then rm -f "$temporary"; printf "Bootstrap checksum mismatch. Nothing was executed.\n" >&2; return 1; fi
  mv "$temporary" "$destination"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then bootstrap_download "$@"; fi
