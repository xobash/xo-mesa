<p align="center">
  <img src="docs/mesa-wordmark.png" alt="Mesa" width="440" />
</p>

<p align="center">
  <strong>A local desktop workspace for research, documents, tools, and action.</strong><br />
  <a href="#quick-start">Quick Start</a>&nbsp;·&nbsp;<a href="#features">Features</a>&nbsp;·&nbsp;<a href="#local-first-guarantees">Local-first</a>&nbsp;·&nbsp;<a href="#requirements">Requirements</a>&nbsp;·&nbsp;<a href="#development">Development</a>&nbsp;·&nbsp;<a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img alt="Platform: macOS, Windows, Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-1f6feb" />
  <img alt="Local first" src="https://img.shields.io/badge/local-first-24c8db" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

## What Is Mesa?

Mesa is a local-first desktop workspace built around a normal folder on your
computer. It combines notes, documents, research, tasks, terminal tools, and a
living graph. Your files stay portable and under your control. Mesa does not
require an account or a hosted cloud service.

<p align="center">
  <img src="docs/mesa-hero-themes.png" alt="Mesa shows a document workspace and a living graph" width="100%" />
</p>

---

## Quick Start

Use signed packages from [Releases](https://github.com/xobash/xo-mesa/releases)
when a release is available. Verify its checksum and provenance before opening
it; see [release verification](docs/release.md). Ordinary CI bundles are
unsigned development artifacts. Mesa does not yet have a published signed
end-user release.

### Verified source bootstrap

For a published `v0.1.0` source release, these commands check the bootstrap's
reviewed SHA-256 before execution. The installer then verifies the signed
release tag using Git's configured release-signing trust and launches only that
version. Install the maintainer's verified public signing key before use;
signature failures stop setup. These commands deliberately fail until that
signed release exists. Source setup installs supported missing build tools and
reuses an unchanged local release build on later starts.

macOS and Linux:

```bash
( set -e; p=$(mktemp); trap 'rm -f "$p"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/xobash/xo-mesa/v0.1.0/install.sh -o "$p"; if command -v shasum >/dev/null; then printf '6c4a390912e85dea27ee55824f59f858a9a18c39115fc2bcb66302db5a6702cb  %s\n' "$p" | shasum -a 256 -c -; else printf '6c4a390912e85dea27ee55824f59f858a9a18c39115fc2bcb66302db5a6702cb  %s\n' "$p" | sha256sum -c -; fi; bash "$p" )
```

Windows 10 and Windows 11:

```powershell
& { $ErrorActionPreference = 'Stop'; $p = Join-Path ([IO.Path]::GetTempPath()) (([guid]::NewGuid().ToString('N')) + '.ps1'); try { Invoke-WebRequest https://raw.githubusercontent.com/xobash/xo-mesa/v0.1.0/install.ps1 -OutFile $p; if ((Get-FileHash $p -Algorithm SHA256).Hash -ne '3a5155311672978ecdc002392d9c328829b31a96c6c371378ae7ffa852146f78') { throw 'Mesa bootstrap checksum mismatch' }; Get-Content -Raw $p | Invoke-Expression } finally { Remove-Item $p -ErrorAction SilentlyContinue } }
```

The source installers preserve existing local files and refuse non-fast-forward
updates. Windows also preserves untracked source changes across an update and
stops before launch if restoring them conflicts. Source builds include local
source edits; use the signed packages for the reviewed release bytes.

### Development checkout

For development before the first signed release, use a reviewed checkout from
protected `main`. This is a source-development path with build prerequisites,
not a signed end-user package:

```bash
git clone https://github.com/xobash/xo-mesa.git
cd xo-mesa
bash run.sh
```

On Windows, run `run.cmd` from the checkout. First builds can take several
minutes; unchanged sources, dependencies, and toolchains reuse the local build.

## Features

- **Living graph** — Visualize relationships between notes, files, reads,
  edits, and attachments.
- **Flexible workspace** — Dock and detach documents, search, tasks, calendar,
  terminal tools, and research.
- **Overlay & Embedded Pi agent** — Keep calendar, scratchpad, whiteboard, and
  [Pi](https://pi.dev), an optional coding agent, close at hand in Mesa's overlay, with the same Pi terminal session shared
  across the workspace and native windows.
- **Deep Research** — Gather sources, validate reports, and review proposed
  file changes before Mesa applies them.
- **Document tools** — Open text, PDF, RTF, saved web pages, images, and video
  in one workspace.
- **Device sync** — Pair devices directly on a local network, through
  Tailscale, or with an explicit endpoint.

## Local-first Guarantees

- Your vault is a normal folder.
- Mesa's native vault commands require a folder approved through the system
  picker. The optional Pi terminal runs with your normal operating-system
  permissions.
- Mesa requires no account and sends no telemetry.
- Mesa does not use a Mesa-operated cloud service.
- If you use Pi with an external model provider, Pi sends the prompts and tool
  results that you choose through that provider's service. Device sync sends
  selected vault files to the peer devices that you configure.
- Mesa verifies writes and preserves a recovery copy after a failed save.
- Device sync transfers a one-sided edit when both devices share a recorded
  earlier version. When both sides change, Mesa keeps a conflict copy.
- Direct device sync verifies that a peer knows the sync key before any file
  manifest or file transfer; TLS certificate pinning binds that proof to the peer.

Read the [security model](docs/security.md), [vault safety contract](docs/vault-safety.md),
[sync guide](docs/sync.md), and [Deep Research contract](docs/deep-research.md).

## Requirements

| Platform | Status |
| --- | --- |
| macOS | Supported |
| Linux | Supported |
| Windows 10 and Windows 11 | Supported |

For manual development, install:

- Node.js 20.19 or later.
- Rust.
- npm.

## Status

> **Status:** Early development. Mesa is usable, but its behavior can change
> between releases.

## Development

After you install the requirements, run:

```bash
npm install
npm run mesa
```

Use these checks during development:

```bash
npm test
npm run typecheck
npm run build
npm run mesa:build
```

`npm run dev` starts a browser demo. `npm run mesa` starts a debug desktop
session for development. The setup scripts use a release build.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, verification steps, and pull request guidance.

## License

Mesa uses the [MIT License](LICENSE).
