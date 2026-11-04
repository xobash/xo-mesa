#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo "A macOS host is required." >&2
  exit 1
fi
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "Set APPLE_SIGNING_IDENTITY to a Developer ID Application identity." >&2
  exit 1
fi
if ! security find-identity -v -p codesigning | grep -F "${APPLE_SIGNING_IDENTITY}" | grep -Fq 'Developer ID Application'; then
  echo "The requested Developer ID signing identity is unavailable in this keychain." >&2
  exit 1
fi
if [[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ ! -r "${APPLE_API_KEY_PATH}" ]]; then
    echo "The Apple notarization API key file is not readable." >&2
    exit 1
  fi
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
else
  echo "Set either the Apple notarization API key or APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID." >&2
  exit 1
fi
for command in npm xcrun codesign spctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing release tool: $command" >&2
    exit 1
  fi
done

if [[ "${1:-}" == "--check" ]]; then
  echo "macOS signing and notarization inputs are available."
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: scripts/release-macos.sh [--check]" >&2
  exit 1
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run mesa:build -- --target universal-apple-darwin
app="src-tauri/target/universal-apple-darwin/release/bundle/macos/Mesa.app"
if [[ ! -d "$app" ]]; then
  echo "Universal Mesa.app was not produced." >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose "$app"
dmg_dir="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
shopt -s nullglob
dmgs=("$dmg_dir"/*.dmg)
if [[ ${#dmgs[@]} -ne 1 ]]; then
  echo "Expected one universal Mesa DMG." >&2
  exit 1
fi
hdiutil verify "${dmgs[0]}"
xcrun stapler validate "${dmgs[0]}"
echo "Signed and notarized universal Mesa app and DMG passed local verification."
