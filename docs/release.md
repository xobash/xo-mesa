# Release Process

Mesa releases are manual, privacy-preserving desktop releases. They do not add
telemetry, background update checks, or a Mesa-operated service.

## Release Inputs

- A clean `main` commit that has passed the full GitHub Actions build matrix.
- A completed native acceptance record for each platform claimed in the
  release notes.
- Public release notes that contain no local paths, private vault names,
  internal assistant/provider names, credentials, or machine-specific records.
- Signing material supplied only through the release runner or GitHub Secrets.
  Do not commit certificates, keys, provisioning profiles, API keys, or
  notarization credentials.

## Build Gates

Before publishing, run or confirm:

```bash
npm run typecheck
npm test
npm run test:bootstrap
npm run test:index
npm run build
npm run audit:public
npm audit --audit-level=moderate
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo audit --file src-tauri/Cargo.lock
```

The GitHub Actions matrix must also pass for frontend, Rust advisory, Rust on
Linux/macOS/Windows, and desktop bundles on Linux/macOS/Windows. The frontend
job runs `npm run audit:public`, so the tracked public payload is checked on
ordinary pushes and pull requests before a release is considered.

## Signing and Notarization

Unsigned bundles are development artifacts. A public end-user release needs:

| Platform | Release requirement |
| --- | --- |
| Windows | MSI and NSIS bundles signed with an Authenticode certificate. |
| macOS | Universal app signed with an Apple Developer ID certificate and notarized. |
| Linux | AppImage/`.deb` attached with checksum; optional detached GPG signature. |

Signing is allowed only for release builds. Pull requests and ordinary pushes
must keep the read-only unsigned build path so contributors and CI do not need
private credentials.

## Privacy Audit

Audit the exact release commit, release notes, uploaded artifacts, and public
repository refs before publishing:

- `npm run audit:public` passes against the tracked repository payload.
- No private names, local paths, vault names, screenshots, or machine records.
- No internal assistant, provider, automation, or prompt metadata.
- No certificates, API keys, sync keys, tokens, or generated identity material.
- No `*.local.md`, `REQUESTS.local.md`, `CONTINUE_PROMPT.local.md`,
  `HANDOFF.md`, `output/`, `tmp/`, or private measurement logs.

## Publishing

1. Confirm native acceptance records and CI matrix results.
2. Tag the release from `main`.
3. Build signed/notarized bundles with the release-only credentials.
4. Attach platform bundles and checksums to the GitHub Release.
5. Re-audit the public release page and downloadable assets.

Do not ship automatic updates as a substitute for this process. Mesa can offer
manual, user-initiated update instructions while keeping the app local-first.
