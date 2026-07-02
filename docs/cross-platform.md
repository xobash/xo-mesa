# Cross-platform builds

Mesa is a Tauri 2 app, so one codebase targets Windows, macOS, and Linux
natively from the same Rust + web front-end. There is no separate port.

## What runs where

| Surface | Engine | Notes |
|---------|--------|-------|
| Windows | WebView2 | Ships on Windows 10/11; the installer bootstraps it if missing. |
| macOS | WKWebView | Universal (Apple Silicon + Intel) via `--target universal-apple-darwin`. |
| Linux | WebKitGTK | Needs `libwebkit2gtk-4.1` at build + run time. |
| Browser preview | any browser | The `dist/` web build (demo vault only; no native file access). |

Priority order for first-class support: **Windows first, Linux last** (macOS is
the current dev platform and already works).

## Local builds

```bash
npm install
npm run mesa           # run the desktop app (debug)  [= tauri dev]
npm run mesa:build     # produce a release bundle for the current OS  [= tauri build]
```

The first `run.sh` / `run.cmd` does all of this for you (and installs Rust
locally if needed). The public bootstrap commands now match on every OS:
`curl -fsSL .../install.sh | bash` on macOS/Linux and `irm .../install.ps1 | iex`
on Windows. `install.sh` installs Git when needed, clones or fast-forwards the
checkout, and then hands off to `run.sh`; `install.ps1` does the same before
handing off to `run.cmd`. `run.cmd` prefers user-local Scoop installs but falls
back to `winget` for Node.js, Git, and Rust when Scoop cannot bootstrap in the
current PowerShell environment. It verifies `cargo` and Microsoft C++ Build
Tools before launching Tauri, so setup stops at the missing dependency instead
of failing later in `cargo metadata` or the Rust link step. The setup scripts
also clear a stale Rust build cache if the project folder was moved or renamed.

## CI build matrix

`.github/workflows/build.yml` runs on every push/PR:

1. **frontend** — `typecheck` + `test` + web `build` on Linux (fast gate).
2. **desktop** — a matrix of `windows-latest`, `macos-latest`, `ubuntu-latest`
   using [`tauri-action`], uploading each platform's bundle as an artifact.
   `fail-fast: false` so one OS failing doesn't cancel the others.

Linux runners install the WebKitGTK/GTK dev packages first; macOS builds a
universal binary; Windows explicitly produces NSIS and MSI installers and uses
the Windows-specific Tauri config (`tauri.windows.conf.json`) for WebView2
bootstrapper settings.

To cut a release, add a tag and have `tauri-action` attach the bundles to a
GitHub Release (set `tagName`/`releaseName` in the action `with:` block).

## Docker

A `Dockerfile` builds and serves the **web** build (browser preview) behind
nginx — useful for a headless demo, hosting the preview, or front-end CI:

```bash
docker build -t mesa-web .
docker run --rm -p 8080:80 mesa-web   # http://localhost:8080
```

A GUI desktop app is **not** a natural Docker target (no system webview / display
in a container), so the desktop bundles come from the CI matrix above, not Docker.

## Per-OS considerations in the code

- **Paths** — all vault paths are normalized to forward slashes in `lib/vault.ts`;
  the Rust side (`sync.rs`) joins safely and rejects traversal. `canonicalRoot`
  also uppercases Windows drive letters (`c:/…` → `C:/…`) so one folder is never
  remembered under two spellings. `normalizeVaultRelPath` maps every external
  path form Windows produces — backslash absolutes, `file:///C:/…` drive-letter
  URLs, `file://server/share/…` UNC URLs — and matches the vault root
  case-insensitively (vault filesystems are case-insensitive on Windows and by
  default on macOS) while requiring a real path-segment boundary, so the graph
  flickers and the watcher resolves files no matter how a tool spells the path.
- **File names** — `safeBaseName` (`lib/fsnames.ts`) sanitizes user-entered
  names on *every* platform to the Windows rules: strips `\ / : * ? " < > |`
  and control characters, trailing dots/spaces, and refuses reserved device
  names (`CON`, `NUL`, `COM1`…). A vault created on macOS therefore never
  contains a name that breaks it on a synced Windows device.
- **Launcher** — `scripts/dev.mjs` prepends Cargo's bin dir, then runs the
  project-local Tauri CLI through the current Node executable. It does not
  depend on `npx`/`npx.cmd` being installed or discoverable on Windows.
- **Pi terminal** — the Rust PTY resolver checks normal executable names plus
  Windows `PATHEXT` shims (`.exe`, `.cmd`, `.bat`, etc.), so npm-installed Pi
  commands under the user npm bin directory can launch. On Windows Mesa now
  prefers those real `PATHEXT` launchers before a same-name extensionless file,
  launches Node shebang scripts through `node.exe`, and only falls back to
  `cmd.exe /d /s /c` for `.cmd`/`.bat` wrappers when necessary. That avoids
  `CreateProcessW ... %1 is not a valid Win32 application` from Unix-style
  shims. When Mesa is launched from the desktop (not a terminal) it may inherit
  a minimal PATH, so the resolver also checks the standard Windows install
  locations directly: `%USERPROFILE%\scoop\shims` (what `run.cmd` installs
  through), `%APPDATA%\npm`, `%ProgramFiles%\nodejs`, and
  `%LOCALAPPDATA%\Programs\nodejs`.
- **Sync server** (`src-tauri/src/sync.rs`) binds `0.0.0.0` and uses `tiny_http`,
  which is portable across all three OSes.
- **File watching** is handled by the Tauri fs plugin (portable).
- **Identifier** `dev.xo.mesa` is fixed; it determines the per-OS app-data dir,
  so keep it stable across releases.

## Code signing (release hardening)

Unsigned builds run everywhere but show OS warnings. For distribution:

- **Windows** — an Authenticode certificate (`tauri-action` supports signing).
- **macOS** — Apple Developer ID signing + notarization.
- **Linux** — AppImage/`.deb` are typically distributed unsigned; optionally GPG-sign.

[`tauri-action`]: https://github.com/tauri-apps/tauri-action
