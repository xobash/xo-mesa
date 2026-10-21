# Release Process

Mesa releases are manual, privacy-preserving desktop releases. They do not add
telemetry, background update checks, or a Mesa-operated service.

## Release Inputs

- A clean `main` commit that has passed the full GitHub Actions build matrix.
- A completed native acceptance record for each platform claimed in the
  release notes.
- Public release notes that contain no local paths, private vault names,
  credentials, or machine-specific records.
- Signing material supplied only through the release runner or GitHub Secrets.
  Do not commit certificates, keys, provisioning profiles, API keys, or
  notarization credentials.

## Release contents

Each published version, including alpha and beta prereleases, contains:

- Platform packages from the exact accepted candidate, with signature and
  provenance verification described below.
- SHA-256 inventories for every downloadable asset.
- A machine-readable SBOM with its source revision and scope. A lockfile-based
  source inventory includes build/development dependencies and conditional
  platform dependencies; it is not a scan of the installed binary or system
  webview. Identify those omissions explicitly.
- A source archive of the exact tagged, audited public tree, excluding private
  working files and build output.
- Release notes listing known limitations, OS/runtime floors, the tested
  architectures, automated and native test results, and security notes.

Distinguish intended OS/runtime floors from versions exercised on the exact
packages. Link the exact CI run and native artifact acceptance summary. State
whether independent security assessment, fuzzing, and reproducibility evidence
exist; do not infer them from a build or a checksum.

Use an explicit prerelease version such as `v0.1.0-alpha.1` and mark it as a
GitHub prerelease. Align the application/manifests and source-bootstrap version
references before signing the candidate. An alpha label does not waive the
existing signing, privacy, or exact-package native acceptance requirements.
Unsigned CI bundles remain development artifacts.

## Build Gates

Before publishing, run or confirm the same commands as the required CI jobs:

```bash
npm ci
npm run typecheck
npm run lint
npm run test:coverage
npm run test:assets
npm run audit:assets
npm run test:toolchains
npm run test:documents
npm run test:capabilities
npm run test:release
npm run test:bootstrap
npm run test:index
npm run test:activity-api
npm run test:markdown
npm run test:notices
npm run build
npm run audit:public
npm run audit:independent
npm audit --audit-level=moderate
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
node scripts/native-advisory-check.mjs
node scripts/third-party-notices.mjs --check-native
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

Verified, versioned source bootstrap builds release mode locally. It still
requires build tooling and a trusted release signing key; it does not replace
signed packages or clean-install acceptance.
Mesa uses the single-instance plugin to focus the existing window when a
second desktop launch is attempted.

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
The normal CI desktop artifacts remain unsigned development builds. The
protected pipeline below supersedes the former macOS-only candidate process.
Signing credentials must be configured before its jobs can pass.

## Privacy Audit

The [control register](security-controls.md) distinguishes incident responses,
audit findings and preventive checks, with executable regressions for each.

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

1. Audit and sign the sanitized changes; pass the required checks, then push
   directly to protected main and verify all CI jobs for that exact commit.
2. Create a signed annotated immutable version tag for that exact commit.
3. Dispatch Release candidate and verify its platform signatures and provenance.
4. Complete native acceptance against those exact downloaded packages.
5. Generate the sanitized release attestation and dispatch Publish verified release.
6. Review the protected publication request and re-audit the public assets.

Do not ship automatic updates as a substitute for this process. Mesa can offer
manual, user-initiated update instructions while keeping the app local-first.

## Protected release pipeline

`Release candidate` is dispatched from protected main with an exact commit and
signed annotated version tag. Its gate verifies the tag signature and target,
main ancestry, and the complete successful CI run for that commit. Lightweight
or unsigned tags, stale CI, failed jobs, or unprotected main stop the build.
No signing credentials are available to pull-request jobs.

Candidate jobs use the reviewed `release` environment and produce:

- macOS: the universal Developer ID app and stapled, verified DMG;
- Windows: SHA-256 Authenticode-signed, timestamped MSI and NSIS installers,
  plus verification of the bundled app executable against the configured signer;
- Linux: one AppImage and one Debian package, with SHA-256 checksums and
  authenticated build provenance.

Every uploaded package, checksum inventory and candidate manifest has GitHub
artifact provenance. All products include the locked third-party notices.
Only verified package formats are copied into candidate output. Signing files
and temporary keys are removed even after failure. These jobs build candidates;
a successful build still does not establish native acceptance.

Candidate builds pin Node 22.22.3 and Rust 1.96.0 with locked dependency
inventories. Hosted OS images and signing timestamps can still change bytes;
these pins do not claim reproducible bit-for-bit packages.

### Workflow action pins

Every `uses:` reference names a full commit SHA. An annotated tag object SHA is
not a commit: GitHub documents action pins as commits, and the resolver's
behavior for a tag object is not guaranteed. Before adding or changing a pin,
confirm that the SHA is a commit of that repository:

```bash
gh api repos/actions/attest-build-provenance/commits/977bb373ede98d70efdf65b84cb5f73e068dcc2a --jq .sha
```

The command prints the same SHA for a commit and fails with HTTP 422 for a tag
object (`git/tags/<sha>` then shows the commit it points to). Record the
reviewed commit here; `npm run test:toolchains` rejects a workflow pin that is
missing from this table.

| Action repository | Reviewed commit | Version |
| --- | --- | --- |
| `actions/attest-build-provenance` | `977bb373ede98d70efdf65b84cb5f73e068dcc2a` | v3.0.0 |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7 |
| `actions/download-artifact` | `634f93cb2916e3fdff6788551b99b062d0335ce0` | v5 |
| `actions/setup-node` | `249970729cb0ef3589644e2896645e5dc5ba9c38` | v6 |
| `actions/upload-artifact` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | v7 |
| `dtolnay/rust-toolchain` | `6bed0761d98439e5a578e2877258200ad565ba87` | stable |
| `github/codeql-action` | `6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee` | v4.39.0 |
| `Swatinem/rust-cache` | `6323deb102c322ba6fcbdcafc7e3dddab59af2b6` | v2 |
| `tauri-apps/tauri-action` | `1deb371b0cd8bd54025b384f1cd735e725c4060f` | v1 |

Windows signing requires protected `WINDOWS_CERTIFICATE_BASE64` and
`WINDOWS_CERTIFICATE_PASSWORD` secrets and the reviewed
`WINDOWS_SIGNING_THUMBPRINT` environment variable. `scripts/release-windows.ps1`
imports the certificate into the temporary runner, configures Tauri signing,
verifies both installer formats and their timestamp certificates, then removes
the imported identity. A certificate-backed signing service may replace this
adapter when its provider requires hardware-backed keys; keep the same signer
and timestamp verification gate. macOS uses the Apple inputs above.

Protect `release` and `release-publish` with owner review and deployment limited
to protected main. Require signed commits and the five prerequisite build
checks on main. Direct fast-forward pushes are allowed without PR approval;
force pushes and branch deletion are blocked. When a new commit needs checks
before main accepts it, push a temporary `verification/*` branch to run build
checks, then push that exact commit to main and remove the temporary branch.
Manually dispatched checks do not satisfy GitHub branch rules.
Block changes and deletion of `v*` tags and enable immutable releases. Reviewers
must inspect the exact version, commit, credentials and evidence, not just the
workflow's green state. Repository administrators retain control of settings.

## Native release attestation

After installing the exact signed candidate packages on every target in
`docs/native-acceptance.md`, complete each native record. Record the exact
commit and installed package's Artifact SHA-256. Then download the candidate
artifacts into one directory and generate a sanitized summary:

```bash
MESA_RELEASE_TAG=v0.1.0 MESA_RELEASE_SHA=$(git rev-parse HEAD) node scripts/release-acceptance.mjs create output/products record-windows-current.local.md record-windows-oldest.local.md record-macos-current.local.md record-macos-oldest.local.md record-linux.local.md
```

The script checks every required workflow is passed with concrete native
evidence, every target exists once, every record uses the candidate commit,
and the installed artifact hash belongs to that platform. It exports only the
version, commit, package hashes, standard target/workflow names, pass results,
and hashes of retained private evidence. Raw machine, tester, vault and evidence
text never enters the public summary. Keep the underlying native evidence
privately; a hash binds evidence but does not independently prove it was tested.
Environment approval is the accountable human verification step.

`Publish verified release` takes the successful candidate run ID, exact tag and
commit, and the generated JSON summary. It downloads those existing packages;
it does not rebuild packages after acceptance. It verifies the run identity,
all package hashes and provenance, and the complete sanitized acceptance
matrix. Missing, failed, stale, duplicate, unexpected or private fields block
publication. Owner approval in `release-publish` is required. The workflow
uploads to a draft first, then publishes the immutable release only after all
assets and the attested summary are attached. Do not bypass a failed gate.

## Release verification

Choose a specific release version; never execute a bootstrap from mutable main.
Download its installer or package, compare SHA-256 with its published inventory,
and verify authenticated provenance, for example:

```bash
gh attestation verify Mesa_0.1.0_amd64.deb --repo xobash/xo-mesa --signer-workflow xobash/xo-mesa/.github/workflows/release-candidate.yml
```

Use the actual filename in that release. Checksums detect changed bytes;
authenticated provenance and the platform signature establish their origin.
Windows must report a valid Authenticode signer and timestamp; macOS must
accept the Developer ID/notarization identity through Gatekeeper. No automatic
background check is introduced.

Source bootstrap requires Git signature verification configured for the
maintainer's approved release key. Verify that key through a trusted channel;
do not treat a key fetched beside a download as an independent trust anchor.

<details>
<summary>Versioned source installation after the first signed release</summary>

### Versioned source bootstrap

**Not available yet:** no `v0.1.0` tag or release is published, so these
commands fail at the download or tag check until the first signed release.
For a published `v0.1.0` source release, these commands check the bootstrap's
reviewed SHA-256 before execution. The installer then verifies that the
release tag is signed by the pinned release identity below and launches only
that version. A signature by any other key stops setup, even a key that the
local Git or GnuPG configuration trusts. These commands require the published
signed release. Source setup installs supported missing build tools and
reuses an unchanged local release build on later starts.

macOS and Linux:

```bash
( set -e; p=$(mktemp); trap 'rm -f "$p"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/xobash/xo-mesa/v0.1.0/install.sh -o "$p"; if command -v shasum >/dev/null; then printf 'a40f7799e2697ec7fc0bd0af99147bb4c18d7082e2eca198f3aeec7a6ae9c04a  %s\n' "$p" | shasum -a 256 -c -; else printf 'a40f7799e2697ec7fc0bd0af99147bb4c18d7082e2eca198f3aeec7a6ae9c04a  %s\n' "$p" | sha256sum -c -; fi; bash "$p" )
```

Windows 10 and Windows 11:

```powershell
& { $ErrorActionPreference = 'Stop'; $p = Join-Path ([IO.Path]::GetTempPath()) (([guid]::NewGuid().ToString('N')) + '.ps1'); try { Invoke-WebRequest https://raw.githubusercontent.com/xobash/xo-mesa/v0.1.0/install.ps1 -OutFile $p; if ((Get-FileHash $p -Algorithm SHA256).Hash -ne '2be8e336d94a6c8d56e092ed0d180d9856cb470e2661a75f1b48c3e4ef0b9582') { throw 'Mesa bootstrap checksum mismatch' }; Get-Content -Raw $p | Invoke-Expression } finally { Remove-Item $p -ErrorAction SilentlyContinue } }
```

The source installers preserve existing local files and refuse non-fast-forward
updates. Windows also preserves untracked source changes across an update and
stops before launch if restoring them conflicts. Source builds include local
source edits; use the signed packages for the reviewed release bytes.

</details>

### Release signing identity

Release tags are signed with the maintainer's SSH signing key. Both installers
pin it:

| Field | Value |
| --- | --- |
| Principal | `xobash@users.noreply.github.com` |
| Key | `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD4Ut8iLVnnB4ps75Fmr5gwgnHfmf+Jm+ZKZtVTr8Di` |
| Fingerprint | `SHA256:JTK3hA6m0Hr2/77nrt0wTl0n38Lrl8HuraqKbvZd3so` |
| OpenPGP fingerprints | none |

The installers write a temporary allowed-signers file that holds only this
key, run `git -c gpg.ssh.allowedSignersFile=<file> verify-tag --raw <tag>`, and
require exit status 0 and the line
`Good "git" signature for <principal> with <type> key <fingerprint>` for the
pinned principal and fingerprint. An OpenPGP signature passes only when a
`[GNUPG:] VALIDSIG` line names a pinned signing or primary fingerprint; the
list is empty, so OpenPGP-signed tags are refused. To check a tag by hand:

```bash
printf '%s namespaces="git" %s\n' xobash@users.noreply.github.com 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD4Ut8iLVnnB4ps75Fmr5gwgnHfmf+Jm+ZKZtVTr8Di' > mesa-signers
git -c gpg.ssh.allowedSignersFile=mesa-signers verify-tag --raw v0.1.0
```

Changing the signing key changes both installers, so their reviewed hashes
above change too. `npm run test:bootstrap` binds the hashes to the installer
bytes, and the installer suites reject foreign SSH keys, foreign principals and
foreign OpenPGP fingerprints.

Update the version references and both reviewed hashes together for each source
release. The shell bootstrap pins NVM 0.40.5's two runtime files and Rustup
1.28.2's architecture-specific binary hashes; mismatched downloads stop before
execution. Windows uses existing Scoop or Winget packages and never runs
get.scoop.sh. Package managers and their artifact/signature checks remain part
of the source toolchain trust. Development checkouts are a separate path.

## Native advisory review

`node scripts/native-advisory-check.mjs` runs the current registry-backed Cargo
audit. It rejects vulnerabilities and every unreviewed warning. Only the exact
legacy GTK and `zbus` 5 warning/package/version combinations documented in
`docs/security.md` are tracked. A version or advisory change requires review;
removal needs the supported upstream GTK and D-Bus binding transitions and
fresh Linux acceptance, not a forced incompatible dependency override.

The source installer checks that the final checkout commit equals the signed
release tag; an ahead checkout is preserved and never launched by this path.

## Binary publication review

Run `node scripts/asset-metadata.mjs --inventory inventory.json` against the
exact candidate. It inventories every binary in the public allowlist, including
icon containers, and rejects unsupported formats or textual/location metadata.
A human must inspect each static image and every demo frame for personal
content before recording `status: "approved"`, `reviewerType: "human"`, a
`reviewedOn` date and concise evidence for its exact SHA-256 in
`docs/binary-review.json`. Record no personal names or local paths. Changed
hashes require renewed review. `node scripts/asset-metadata.mjs --review
docs/binary-review.json` rejects pending, missing or stale entries; the release
candidate gate executes it against the requested commit. Metadata checks and
automated frame sampling do not establish human pixel approval.
