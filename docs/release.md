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
npm run test:markdown
npm run test:notices
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

`npm run build` checks `public/THIRD_PARTY_NOTICES.txt` against both lockfiles
and copies it into `dist/`. The desktop bundle includes the same notice file as
a Tauri resource. After dependency changes, run `npm run notices:generate` with
installed locked packages, inspect the resulting attribution, then rebuild.
Mesa's own `LICENSE` remains separate. The PDF.js Apache 2.0 license and its
font notices are required build material. Normal frontend builds need no Rust
registry cache: they validate both lock hashes, the native-text checksum and
installed frontend license bytes. The Rust advisory job separately fetches the
locked crates and runs `node scripts/third-party-notices.mjs --check-native` to
compare the complete native inventory. Lock hashes normalize platform line endings;
notice paths use forward slashes on every OS. Both checks must pass.

## Signing and Notarization

The one-command source setup now builds Mesa in release mode and launches that
binary. It is still a source build with local toolchain requirements. It does
not satisfy signing, notarization, or clean-install acceptance.
Mesa holds one instance lock per user so a second desktop launch exits.

Unsigned bundles are development artifacts. A public end-user release needs:

| Platform | Release requirement |
| --- | --- |
| Windows | MSI and NSIS bundles signed with an Authenticode certificate. |
| macOS | Universal app signed with an Apple Developer ID certificate and notarized. |
| Linux | AppImage/`.deb` attached with checksum; optional detached GPG signature. |

Signing is allowed only for release builds. Pull requests and ordinary pushes
must keep the read-only unsigned build path so contributors and CI do not need
private credentials.

On a macOS release runner, install a Developer ID Application identity in the
keychain and provide `APPLE_SIGNING_IDENTITY`. For notarization, provide either
`APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_KEY_PATH`, or `APPLE_ID`,
`APPLE_PASSWORD`, and `APPLE_TEAM_ID`. The Apple ID route uses an app-specific
password. Neither route submits Mesa to the Mac App Store. Keep credentials
outside the repository. Run
`bash scripts/release-macos.sh --check` before the release window, then
`bash scripts/release-macos.sh` after native acceptance and privacy review.
The script builds the universal bundle, verifies its code signature, validates
the stapled notarization ticket, and checks Gatekeeper acceptance. A missing
identity, key, app, ticket, or failed assessment stops the release.
The normal CI desktop artifacts remain unsigned and are not release downloads.
Configure a GitHub `release` environment with required reviewers and restrict
its deployment branch to `main` before adding secrets. The `macOS release
candidate` workflow is manually dispatched from `main` into that environment.
It imports the certificate and
notarization key from environment secrets, runs the same verification script,
and uploads revision-labelled bundles plus SHA-256 checksums. It does not tag
or publish a GitHub Release. Required environment secrets are
`APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, and
`APPLE_API_KEY_BASE64`. The certificate and API key files exist only on the
runner. A successful workflow still needs clean install/upgrade acceptance on
real macOS machines.

## Privacy Audit

Audit the exact release commit, release notes, uploaded artifacts, and public
repository refs before publishing:

- `npm run audit:public` passes against the tracked repository payload.
- No private names, local paths, vault names, screenshots, or machine records.
- No internal assistant, provider, automation, or prompt metadata.
- No certificates, API keys, sync keys, tokens, or generated identity material.
- The tracked tree matches the explicit public-file allowlist; local-only
  exclusions, session records, and measurement files are not published.
- Confirm actual data flows, external services, user permissions, accessible
  task flows, asset rights, and public feature claims before release. Record
  policy or legal questions that need a qualified review without inventing
  business details or a compliance claim.
- Review source and reachable history for exposed keys, personal paths,
  assistant artifacts, obsolete comments, unused dependencies, weak tests,
  skipped checks, and commands that fail on their stated platform.

## Publishing

1. Confirm native acceptance records and CI matrix results.
2. Tag the release from `main`.
3. Build signed/notarized bundles with the release-only credentials.
4. Attach platform bundles and checksums to the GitHub Release.
5. Re-audit the public release page and downloadable assets.

Do not ship automatic updates as a substitute for this process. Mesa can offer
manual, user-initiated update instructions while keeping the app local-first.
