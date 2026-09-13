# Cross-platform builds

Mesa is a Tauri 2 app, so one codebase targets Windows, macOS, and Linux
natively from the same Rust + web front-end. There is no separate port.

## What runs where

| Surface | Engine | Notes |
|---------|--------|-------|
| Windows | WebView2 | Ships on Windows 10/11; the installer bootstraps it if missing. |
| macOS | WKWebView | macOS 13.3+; universal (Apple Silicon + Intel) via `--target universal-apple-darwin`. |
| Linux | WebKitGTK | Needs `libwebkit2gtk-4.1` at build + run time. |
| Browser preview | any browser | The `dist/` web build (demo vault only; no native file access). |

The frontend build target is explicit: Chrome/WebView2 111 or newer and
Safari/WKWebView 16.4 or newer. This matches Windows 10/11 with Evergreen
WebView2 and macOS 13.3+ while still compiling away JavaScript syntax that an
older supported webview would not parse. Do not use Vite's `esnext` target for
desktop bundles; it is a moving build-host promise, not a Mesa support matrix.

The native acceptance matrix is the concrete set of machines/runtimes Mesa uses
to prove that promise:

| Matrix target | Runtime floor | Acceptance role |
| --- | --- | --- |
| Windows 11 current WebView2 | Evergreen WebView2 111+ | Current Windows release confidence |
| Windows 10 oldest WebView2 | Evergreen WebView2 111+ | Oldest Windows support proof |
| macOS current WKWebView | Current Safari/WKWebView | Current macOS release confidence |
| macOS 13.3 oldest WKWebView | Safari/WKWebView 16.4 | Oldest macOS support proof |
| Linux current WebKitGTK smoke | WebKitGTK 4.1 | Lower-priority build and launch smoke |

Generate and check records with:

```bash
npm run acceptance:native-template > native-acceptance.local.md
npm run acceptance:native-check -- native-acceptance.local.md
```

Priority order for first-class support: **Windows first, Linux last** (macOS is
the current dev platform and already works).

## Windows and macOS parity

The core Mesa feature set is shared: vault open and watch, Markdown editing and
verified saves, search, graph, previews and PDF editing, Pi, Deep Research,
sync, and Mesa-owned detached views. The front-end and Rust contracts do not
fork these features by operating system.

The practical differences are platform dependencies and native window details:

| Area | Windows | macOS |
|------|---------|-------|
| Desktop webview | WebView2 must be installed or bootstrapped. | WKWebView is supplied by macOS. |
| Desktop build | Rust requires the MSVC compiler and linker. `run.cmd` activates the Visual Studio environment before launch. | Rust uses the installed Apple toolchain; the build script supports a universal binary. |
| Pi launch | The resolver handles `PATHEXT`, `.cmd`/`.bat` wrappers, Node shebangs, and the shorter desktop PATH. | The normal executable and shell PATH are used. |
| Native windows | Mesa-owned document, Pi, Research, Preview, Tasks, and Calendar windows use dark launch chrome; Graph intentionally follows the OS. Native creation failures restore the surface inside Mesa. | The same surfaces are available, with macOS title-bar treatment where needed; native creation failures also restore the surface inside Mesa. |
| Local-network sync | Windows Firewall can block inbound pairing or discovery until the user allows Mesa. | The local firewall can impose the same kind of network permission. |
| Path limits | Long paths can require an administrator-enabled Windows setting; the bootstrap warns before the first Rust build. | No equivalent 260-character Windows limit applies. |

Windows should therefore be functionally comparable after its runtime and build
prerequisites are present. This repository can verify Windows Rust compilation
in CI and static bootstrap contracts, but a macOS workspace cannot prove a
clean Windows install, WebView2 bootstrap, firewall prompt, native window
painting, or a real Windows Pi/provider session. Those remain physical Windows
acceptance checks.

## Local builds

```bash
npm install
npm run mesa           # run the desktop app (debug)  [= tauri dev]
npm run mesa:build     # produce a release bundle for the current OS  [= tauri build]
npm run mesa:build:windows:offline # Windows bundle with an offline WebView2 runtime
```

The first `run.sh` / `run.cmd` does all of this for you (and installs Rust
locally if needed). The public bootstrap commands now match on every OS:
`curl -fsSL .../install.sh | bash` on macOS/Linux and `irm .../install.ps1 | iex`
on Windows. `install.sh` installs Git when needed, clones or fast-forwards the
checkout, and then hands off to `run.sh`; `install.ps1` does the same before
handing off to `run.cmd`. `run.cmd` prefers user-local Scoop installs but falls
back to `winget` for Node.js, Git, and Rust when Scoop cannot bootstrap in the
current PowerShell environment. It executes `cargo --version` rather than
trusting executable presence because Rustup can install a Cargo proxy before a
default toolchain exists. If that check fails while Rustup is available,
`run.cmd` configures `stable-msvc` and verifies Cargo again. It also verifies
Microsoft C++ Build Tools before launching Tauri, so setup stops at the missing
dependency instead of failing later in `cargo metadata` or the Rust link step.
The setup scripts also clear a stale Rust build cache if the project folder was
moved or renamed.

## CI build matrix

`.github/workflows/build.yml` runs on every push/PR:

1. **frontend** — `typecheck` + `test` + web `build` + `npm audit` on Linux
   (fast gate).
2. **rust** — `cargo test` + `cargo clippy -D warnings` on `ubuntu-latest`,
   `windows-latest`, and `macos-latest`. Windows is in the matrix because the
   PTY resolver's PATHEXT lookup, the Node-shebang launch path, and the
   `cmd.exe` wrapper fallback are all `#[cfg(target_os = "windows")]` — a
   Linux-only run never compiles them. macOS is in the matrix so Rust tests and
   lints exercise the same platform family that ships the WKWebView desktop
   bundle, rather than only building it.
3. **rust-advisory** — `cargo audit --file src-tauri/Cargo.lock` on Linux, so
   RustSec vulnerabilities gate the Rust dependency tree just as `npm audit`
   gates the web dependency tree.
4. **desktop** — needs all gates above, then a matrix of `windows-latest`,
   `macos-latest`, `ubuntu-latest` using [`tauri-action`], uploading each
   platform's bundle as an artifact. `fail-fast: false` so one OS failing
   doesn't cancel the others.

Linux runners install the WebKitGTK/GTK dev packages first; macOS builds a
universal binary; Windows explicitly produces NSIS and MSI installers and uses
the Windows-specific Tauri config (`tauri.windows.conf.json`) with the small
Evergreen download bootstrapper. Use
`npm run mesa:build:windows:offline` only for disconnected deployment media;
it overlays `tauri.windows.offline.conf.json` and includes the much larger
offline runtime. The Windows bootstrap also verifies that the versioned
WebView2 runtime executable exists after the install attempt and stops with a
repair message if it does not.

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
- **IPC round-trip count is a Windows performance concern, not just a latency
  one.** Every Tauri `invoke` uses the custom-protocol IPC on every platform
  except Android (`tauri/scripts/ipc-protocol.js`). On Windows that becomes a
  WebView2 `WebResourceRequested` event raised on the app's **UI thread**, and
  because commands are async, wry returns the response by posting a window
  message to the main HWND and calling `RedrawWindow(.., RDW_INTERNALPAINT)` for
  every one (`wry/src/webview2/mod.rs`). Tauri **events** and **channel sends**
  are worse: each is a JS source string delivered by `eval`, so the webview
  parses and compiles a fresh script per message. macOS has no equivalent
  forced-redraw step. The practical rule: a per-item IPC pattern that measures
  acceptable on macOS can still be *input* latency on Windows, because each
  response competes with `WM_KEYDOWN` and `WM_PAINT` in the same message pump.
  This is why the vault listing (`vault_scan`) and the vault text reads
  (`vault_read_text`) are single bulk commands rather than per-file calls — the
  reads alone were ~2,400 round-trips per vault open on the reference vault and
  are now 20, with the search-corpus share of them running while the user is
  already typing.
- **Sync server** (`src-tauri/src/sync.rs`) binds `0.0.0.0` and serves HTTPS
  through Hyper + Tokio-Rustls on Rustls 0.23. `tiny_http` remains only for
  plain loopback helper/test servers and must not regain its old TLS feature.
- **File watching** prefers Mesa's native `vault_watch`
  (`src-tauri/src/vaultwatch.rs`), falling back to the Tauri fs plugin's `watch`
  (both portable). See the Windows UI-thread note below for why the native path
  exists.
- **Long paths (Windows)** — Windows refuses paths over 260 characters unless
  `LongPathsEnabled` is set machine-wide, and Git enforces the same cap itself
  unless `core.longpaths` is on. Cargo and Tauri nest build artifacts roughly
  150 characters below the project root (crate out-dirs carry a 16-hex-digit
  hash), so a long root — a OneDrive-redirected `Documents` folder gets there
  unaided — fails partway through the *first* Rust build, well after setup
  looked successful. `install.ps1` passes `-c core.longpaths=true` for its own
  clone/pull only, never touching the user's global Git config. `run.cmd`
  checks the registry value up front and, when long paths are off *and* the
  project path is past 90 characters, prints both remedies (move the folder, or
  run one `reg add` from an admin terminal). It reports rather than applies:
  that key is a machine-wide admin change, and it never blocks the run.
  Pinned by `src/lib/runCmdContract.test.ts`.
- **App exit** — `lib.rs` handles `RunEvent::Exit` to kill every PTY child and
  stop the activity server. On Windows each ConPTY leader is assigned to a
  kill-on-close Job Object immediately after spawn. Closing the Job Object
  takes its complete process tree with it, including a wrapper-launched Node or
  Pi grandchild that would otherwise keep vault/build files locked.
- **UI-thread cost of IPC and events (Windows only)** — on every OS except
  Android a Tauri `invoke` uses the custom-protocol `fetch` IPC. On Windows
  that is a WebView2 `WebResourceRequested` event **raised on the app's UI
  thread**, and wry's dispatcher calls `RedrawWindow(.., RDW_INTERNALPAINT)`
  after every dispatched response. Tauri **events** and **Channel** sends are
  worse still: each is a JS source string `eval`'d into every webview holding a
  listener for it, so each one is a fresh script parse + compile, again on the
  UI thread. All of it serializes against `WM_KEYDOWN`, `WM_PAINT`, and resize.

  macOS has no equivalent step, which is why Mesa's optimization history —
  measured on macOS — did not catch these. The rule is to batch at the Rust
  boundary: `vault_read_text` reads the whole vault in 20 framed round-trips
  instead of ~2,400, `vault_scan` collects entries and crash artifacts in one
  walk, and `terminal.rs` coalesces PTY reads into batched `terminal://output`
  events (a measured 1.3 MB Pi response was 1,303 events in 0.02 s before that
  pump existed — enough to bury the message pump and freeze the window).

  The vault watcher was the same class of problem, now fixed:
  `tauri-plugin-fs`'s `watch` hands its debouncer's `Vec<DebouncedEvent>` to
  `on_event.send` **one event at a time** (`tauri-plugin-fs-2.5.1/src/
  watcher.rs`), so a bulk vault change (git checkout, sync run, agent batch
  write) floods the UI thread — and `.git/` churn crosses the bridge before
  Mesa's JS filter can drop it. `watchVault` now prefers the native
  `vault_watch` (`src-tauri/src/vaultwatch.rs`): the SAME debouncer engine, but
  it filters with `is_indexable_rel` (the `isIndexableVaultRelPath` predicate)
  and coalesces a whole window into ONE `Channel::send`. A `.git`-only window
  sends nothing; a 300-file checkout sends one message instead of hundreds. The
  plugin `watch` remains the fallback. The reduction is pinned in `vaultwatch.rs`
  tests (a 3,301-event window → 1 send; a 5,000-event `.git` storm → 0) — that
  count transfers across OSes because it is set by the workload's distinct paths,
  not by the notify backend; the felt Windows latency win is the on-Windows
  acceptance step.

  The sync console was the same class of problem, now fixed: a full-vault sync
  emitted one `sync://log` plus one `sync://progress` per transferred file on the
  device that started it, and one `[serve]` line per received file on the device
  serving the push — so a first sync of a ~2,400-file vault was ~4,800 UI-thread
  evals + forced repaints on the initiator (plus one per file on the receiver),
  every one competing with `WM_KEYDOWN` while the user keeps editing. `emit_log`
  and `emit_progress` (`src-tauri/src/sync.rs`) now stage into a process-global
  coalescer whose single flusher thread (`sync_emitter`, condvar — zero wakeups
  when idle) batches a whole ~33 ms window into ONE `sync://log` array event and
  collapses `sync://progress` to its latest value; sync end force-drains so the
  final report line is immediate. The frontend's `mergeSyncLog` applies the batch
  in one array copy. The collapse is pinned deterministically (`sync::tests`:
  3,301 staged lines → one drained batch; the frontend caps a 4,000-line batch to
  the retained 1,000 in one pass), so it transfers across OSes for the same
  reason the watcher's does; the felt Windows win is again the on-Windows step.

- **Local timing marks** — `src/lib/mesaPerf.ts` records bounded marks for
  vault-open request, vault readiness, file-open request, search completion,
  and detached-document visibility. The ring is local to the renderer, keeps 256 events, contains no
  vault path, and has a `Date.now()` fallback when an evaluator does not expose
  `window.performance`. The top-bar Diagnostics window reads this same local
  ring along with cache, indexing, save, and sync state. These marks enable
  native macOS and Windows acceptance runs; browser-fixture timings remain
  separate evidence.

- **Launch flash (Windows)** — the `main` window sets `backgroundColor`
  alongside `theme: "Dark"`, and `src/lib/windowChrome.ts` applies the same
  pair to the document popout and the detached Pi surface. Without it, tao's
  `WM_ERASEBKGND` falls through to a NULL window-class brush and the WebView2
  controller keeps its white `DefaultBackgroundColor`, so a dark app flashes
  light until WebView2 boots and paints — on every launch, and again under the
  cursor on every tear-out. `index.html`'s `color-scheme: dark` only covers the
  document canvas, not either native layer. Two windows are deliberately
  excluded: the Pi browser harness (it hosts arbitrary, mostly light, web pages)
  and the torn-off panel window that the Graph detaches into (user decision —
  it keeps following the OS).

- **Identifier** `dev.xo.mesa` is fixed; it determines the per-OS app-data dir,
  so keep it stable across releases.

- **NAS vault opening** — mounted NAS folders use local-looking filesystem APIs,
  but directory enumeration and metadata reads still pay network latency. Mesa
  keeps local-vault behavior unchanged, while UNC roots and macOS `/Volumes/`
  roots use one overlapping 128-file native read batch and a two-worker limit.
  The local renderer timeline records scan completion, Markdown completion, and
  vault readiness so a real NAS run can distinguish listing latency from note
  reads. Unusual mount paths remain on the local profile until measured.

  A remembered network/removable root is availability-checked before Mesa
  replaces the current workspace. If it is missing, Mesa preserves that root as
  the selected vault, shows an explicit disconnected state with Retry/Choose
  actions, and retries every five seconds plus whenever the window regains
  focus. Reconnecting the same mount therefore repopulates the same workspace;
  it is never accepted as a new empty vault. `vault_scan` independently treats
  a root `read_dir` failure as fatal, closing the check-to-scan race and the
  stale-mount case. Child folders that disappear during a scan remain
  best-effort so one transient subtree does not hide the rest of a reachable
  vault.

## Code signing (release hardening)

Unsigned builds run everywhere but show OS warnings. They are development
artifacts, not end-user release artifacts. For distribution:

- **Windows** — an Authenticode certificate (`tauri-action` supports signing).
- **macOS** — Apple Developer ID signing + notarization.
- **Linux** — AppImage/`.deb` are typically distributed unsigned; optionally GPG-sign.

See `docs/release.md` for the manual release inputs, signing/notarization
requirements, privacy audit, and publishing sequence.

[`tauri-action`]: https://github.com/tauri-apps/tauri-action

## Repeatable acceptance

Run `npm run typecheck`, `npm test`, `npm run test:bootstrap`, and `npm run build`.
The bootstrap check executes the actual macOS/Linux wrapper with isolated fake
Git/launch commands; it validates control flow and preservation, not clean-machine
package installation. Windows bootstrap execution still requires Windows.

Use `npm run acceptance:native-template > native-acceptance.local.md` to create
the local acceptance record for a real desktop run. The generated file is
gitignored by the `*.local.md` rule because it may name machines, vaults,
install paths, and OS prompts. Run
`npm run acceptance:native-check -- native-acceptance.local.md` before using a
record as release evidence; the checker requires every row to have a result and
evidence and rejects passed rows backed only by CI, browser, unit-test,
source-contract, or another-OS evidence.

For browser interaction, start `npm run dev` and visit `/scripts/acceptance.html`.
This development-only fixture creates two synthetic demo notes. Compare them in
Sync, combine their text, save, and open the original, retained previous version,
and conflict copy. Check Keep both, Tab/Escape, narrow layout, and console errors.
Reload resets the two test-note contents. The fixture never opens a personal vault.

A release acceptance record must distinguish browser checks from these native
checks on **both macOS and Windows**:

| Workflow | Required observation |
| --- | --- |
| One-command setup and rerun | Installs missing prerequisites, launches, preserves existing files and settings |
| Interrupted setup/upgrade | Clear failure; rerunning the same command completes without losing local work |
| Edit, rapid tab changes, quit | Every changed note reopens with the final saved bytes |
| Drive disconnect/reconnect | Failed saves retain edits; failed opens retain the prior workspace; retry succeeds |
| Sleep/wake and network loss | No duplicate discovery listeners; incomplete sync stays visible and retryable |
| Two-device sync baseline | A real Mac/Windows or oldest/current-platform pair pairs, transfers both directions, restarts, and reruns with no duplicate or missing files |
| Offline third-device sync | A previously paired third device misses changes while offline, returns later, and converges without duplicate, missing, or overwritten files |
| Two-device sync interruption | During real transfer, network loss, peer restart, app quit, sleep/wake, and retry preserve completed files and leave incomplete work visible |
| Sync simultaneous edits | Two devices edit the same text file before syncing; both source versions survive and the conflict review save preserves the reviewed baseline and retained original |
| Sync delete, restore, and rename | Deletes, recovery restores, renames, and rename-plus-edit races preserve user bytes and retract stale local journal intent when restored bytes return |
| Sync certificate change | A peer certificate change stops sync before file data moves, explains the trust problem, and requires deliberate re-trust |
| Interrupted sync journal | A killed or interrupted Mesa instance leaves a journal/report state that retries cleanly without deleting restored files or replaying stale intents |
| Window/keyboard interactions | Native drag/dock, shortcuts, focus, scaling and PDF gestures work on the actual OS |
| Assistive technology and scaling | Keyboard-only use, VoiceOver/Narrator, high DPI, and small displays can reach save, sync, recovery, history, navigation, and PDF controls without overlap or trapped focus |
| Interruption and return flows | After failed save, failed sync, modal close/reopen, app restart, and vault reopen, the same actionable next step remains visible until resolved |
| Long session | Repeated document and sync use does not grow resources without bound |

Do not mark a row passed from a source assertion, browser fixture or another OS's
build. Signing/notarization and OS permission prompts are separate release checks.
See `docs/native-acceptance.md` for the evidence boundary and record format.
