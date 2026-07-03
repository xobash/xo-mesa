# Pi Agent

Pi is Mesa's lightweight agent harness. Press `Cmd/Ctrl + Left Shift + Space`
to open the dedicated Pi overlay. Pi is still available from the Shift+Tab
overlay dock, and it can be placed into the main workspace or popped out as its
own window. The surface launches the actual `pi` CLI in a PTY, not a custom Mesa
chat interface.

## Token Boundary

Pi does not call a model in the background. Mesa exposes the current vault
location and direct view context only when the user asks for it.

The native global shortcut only opens the dedicated Pi overlay. It does not send
context to a provider or start a model call.

The system context contains only what the user is directly accessing:

- vault name and vault path
- active file path, both vault-relative and absolute on disk
- open file paths, both vault-relative and absolute on disk
- center/right pane layout

Mesa does not send the whole vault file list. File contents are not bundled
automatically. The user or provider prompt must explicitly request file reads or
web work when that context is worth spending tokens on.

## Terminal

In the desktop app, Pi starts in the current vault folder through Mesa's native
PTY layer. On Windows this maps to the platform pseudoconsole path exposed by
the same PTY dependency; on macOS/Linux it uses the native pseudoterminal path.
The frontend renders that terminal protocol with xterm.js, so Pi receives raw
keystrokes, ANSI output, cursor movement, terminal resizing, paste, selection,
and provider setup inside the CLI.

Mesa keeps one live Pi PTY/xterm session across the Pi modal, the dedicated
Pi overlay, the Steam-style overlay Pi pane, and the popped-out Pi OS window.
Switching between the in-window surfaces (modal / overlay / workspace pane)
reattaches the same xterm instance instead of spawning a new Pi process,
because they share one JS module singleton within that window.

Popping Pi out into its own OS window is a different kind of transition: a
Tauri `WebviewWindow` is a separate JS realm, so it can't see that singleton
at all. To avoid silently orphaning the running `pi` process and starting a
second, contextless one, Mesa hands the live session id to the new window
through its launch URL (`openAgentWindow` in `store.ts`); the new window
probes that the backend session is still alive with a harmless
`terminal_resize` call and, if so, reattaches its own xterm instance to that
same session (`adoptSharedPiSession` in `AgentPanel.tsx`) instead of calling
`terminal_start`. The reattached window prints a short "Reattached to the
existing Pi session" note since its xterm scrollback starts empty even though
the underlying `pi` process — and its conversation state — carried over
untouched. Because Rust's `TerminalState` and the `terminal://output` event
are already app-global (not per-window), both windows can stay attached to
the same live session at once if the user keeps both open. The window Pi was
popped out of is told the moment the popped-out window receives its first
keystroke (`mesa://pi-input-seen`, broadcast app-wide) so it never mistakes
that session for untouched and auto-restarts it out from under the user.

The session restarts when Mesa changes vaults or the app itself restarts. If Pi
started but the user has not typed into it yet, Mesa may also restart it when
the selected editor/preview file changes so the startup context stays current.
Mesa serializes Pi startup, awaits the previous Tauri output listener cleanup,
and accepts terminal output only when both the session id and listener
generation match the active shared session. That prevents stale PTY output from
rendering twice into the shared xterm during overlay/modal/workspace switches
or pre-input context restarts.

Mesa caches the resolved Pi executable after the first successful launch and
starts the PTY at the terminal's current columns/rows to avoid a visible resize
round trip during startup.

On Windows, Mesa prefers a real `PATHEXT` launcher (`.exe`, `.com`, `.cmd`,
`.bat`) over a same-name extensionless file, because npm and Hermes installs
often ship Unix-style `pi` scripts beside Windows launch shims. If Mesa resolves
an extensionless Node shebang script it launches it through `node.exe`; if only
the Windows wrapper exists it launches that wrapper through `cmd.exe`.

Mesa does not fake a transcript with styled text. It also does not embed
Terminal.app, Windows Terminal, cmd.exe, or PowerShell as an OS-owned child
window inside the Tauri webview; that is not a durable cross-platform target.
Mesa owns the PTY process and renders the terminal stream inside Mesa.

Mesa launches `pi` directly in the current vault folder. The terminal receives
path-only Mesa context through Pi's `--append-system-prompt` startup hook and
mirrors the same values through `MESA_*` environment variables:

- `MESA_VAULT_NAME`
- `MESA_VAULT_PATH`
- `MESA_ACTIVE_PATH`
- `MESA_ACTIVE_FILE_PATH`
- `MESA_OPEN_PATHS`
- `MESA_OPEN_FILE_PATHS`
- `MESA_CENTER_VIEW`
- `MESA_RIGHT_VIEWS`
- `MESA_CONTEXT`

The active file is the document currently selected in Mesa's editor/preview.
When Pi is popped into its own OS window, Mesa carries that selected file in the
window URL before starting the PTY so the injected context still matches the
main workspace.

The terminal can be popped out into its own OS window, and the popout window can
be docked back into the main Mesa workspace.

Provider setup belongs inside the terminal workflow the user chooses to run.
Mesa no longer maintains a separate provider panel for Pi.

`Shift+Tab` is reserved for Mesa's overlay. The embedded terminal intercepts
that key before xterm sends it to Pi, so Pi's own Shift+Tab binding is not used
inside Mesa. To rotate Pi's reasoning level while embedded, use `Ctrl+Shift+Tab`
(Control, not Command); xterm.js drops modifiers on Tab, so Mesa synthesizes the
`ESC [ Z` sequence Pi's default `shift+tab` binding reads as a reasoning
rotation. `Alt+Shift+Tab` is also accepted as an alternate. (Windows key
keyboards use the same `Ctrl+Shift+Tab` / `Alt+Shift+Tab` paths.)

## Living-graph reporting (reads *and* writes)

Mesa's graph reacts when Pi touches a note. Writes and creations are visible to
the filesystem watcher, but **reads never touch disk**, so they need a separate
signal. Mesa provides one that works no matter which model or provider Pi is
driving:

- On launch, Mesa starts a **loopback-only** activity server (`127.0.0.1`, fresh
  per-run bearer token) and loads a bundled Pi extension via `--extension`,
  handing it the port and token through `MESA_ACTIVITY_PORT` /
  `MESA_ACTIVITY_TOKEN`.
- The extension listens on Pi's `tool_call` event — the harness-level hook that
  fires for each built-in `read` / `edit` / `write` before it executes,
  regardless of the underlying model — and reports the path and operation to
  that server. Mesa then flickers the node and floats a live preview card.

This is intentionally observation-only: the extension returns nothing, so it can
never block or alter a tool call, and it is a no-op when the `MESA_ACTIVITY_*`
env vars are absent (i.e. when `pi` runs outside Mesa). Nothing leaves the
device — the report never travels beyond loopback. See
[activity-api.md](activity-api.md) for the wire format and the public LAN
endpoint used by other external tools.

## Writes made by Pi are not made by Mesa

Pi is a real native process with the vault as its cwd. Its `write`/`edit`
tools write straight to disk from that external process, whatever the
provider — this is the one write path in Mesa that `persistVerifiedBytes`
(`src/lib/verifiedWrite.ts`) never sees, so none of Mesa's own backup/atomic-
rename/read-back guarantees apply to it. A tool that mishandles a file it
doesn't understand well — most visibly a binary file like a PDF — can
overwrite it with no recovery path.

Mesa cannot prevent an external process from writing bad bytes; it makes sure
that write is always recoverable instead. The same pre-execution `tool_call`
hook the activity extension already uses (it fires before a `write`/`edit`
tool runs) also takes a defensive snapshot of the file's current on-disk bytes
first, so the state right before any Pi write always has a recovery point.
Full detail — naming/retention contract, the crash-recovery interaction, and
the restore path — is in [vault-safety.md](vault-safety.md). Short version:
snapshots are dot-prefixed siblings (invisible to scan/watch/sync, same as
Mesa's own write artifacts), pruned to the newest 5 per file / 14 days at
vault open, and never auto-restored — `PdfView` offers a "Restore previous
version" action when the open PDF turns out not to be valid instead.

## /goal command

The embedded Pi agent ships with a built-in `/goal` slash command, provided by
a second bundled extension (`mesa-goal.ts`) loaded alongside the activity
extension via Pi's repeatable `--extension` flag.

- `/goal <text>` pins a session goal. It is re-appended to the system prompt on
  every agent turn (so it cannot fade out of the context window) and shown as a
  widget above Pi's editor.
- `/goal` alone shows the current goal.
- `/goal clear` (also `done` / `none` / `off`) removes it.

The goal persists as a custom session entry, so resuming or branching a session
restores the goal that was active at that point in history. The extension is
dependency-free — no imports, no npm packages, no network or filesystem access —
and is compiled into the Mesa binary (`include_str!`), so what ships is exactly
what is code-reviewed in this repo. Nothing is fetched at runtime, which keeps
this path outside the blast radius of npm supply-chain attacks.

## Browser Harness

The browser harness is a tool, not the default view. The ⌕ button near the
terminal slides it out **from behind the Pi window, to its right** — the Pi
window keeps its size and the terminal is never covered or squeezed. In bounded
surfaces (a workspace pane or the popped-out Pi OS window, where nothing exists
beyond the surface edge) the harness opens as an inline sibling pane instead.
Both variants are resizable by dragging the wing's outer edge.

In the desktop app the harness page surface is a **real native child webview**
(Tauri multiwebview, `unstable` cargo feature; `src-tauri/src/harness.rs`),
not an iframe:

- Pages render fully — JavaScript, sessions, sign-ins, google.com/youtube.com
  and every other site that blocks embedding. The old iframe approach hit
  `X-Frame-Options` / CSP `frame-ancestors` on exactly the sites people use
  most and fell back to a scriptless "reader mode" that showed no-JS variants
  and JS-shell skeletons — pages that looked like counterfeit copies of the
  real site. That failure mode is gone.
- The frontend owns the webview's rectangle: `BrowserHarness.tsx` measures the
  wing's page slot every animation frame and pushes changed bounds to Rust
  (`harness_bounds`), so the webview follows wing slides, pane resizes, and
  overlay drags. Its visibility follows the wing (`harness_visibility`); the
  page survives a closed wing and is re-adopted when the wing reopens
  (`harness_status`).
- Because the native webview composites above Mesa's DOM, the wing's page area
  is reserved for it while open; Mesa UI must not rely on floating anything
  over that rect.
- If native webview creation fails at runtime, the harness falls back to the
  legacy two-tier iframe path for the session: `browse_fetch` header check →
  direct iframe when framing is allowed, sandboxed srcdoc reader mode (no
  `allow-same-origin`, injected `<base>` + postMessage navigation bridge) when
  blocked. The browser demo (no Rust) always uses the legacy path.

Address-bar semantics (shared with the Pi mirror path via `resolveNavTarget`):

- search terms open a DuckDuckGo search URL
- full URLs open directly
- Back/Forward/Reload drive the real webview's history (`harness_history`)
- Archive saves the current page into `Web Archives/` inside the active vault
  via a native `browse_fetch` of the current URL

### Pi uses — and sees — the same harness the user sees

Every page in the harness webview gets an injected **reporter**
(`src-tauri/resources/harness-reporter.js`, top frame only): it snapshots the
*rendered* DOM (title, visible text, outgoing links) after load, on DOM
mutations (debounced), and on SPA pushState navigations, and streams the
snapshots to Mesa. Two transports keep this working on every platform webview:
a `no-cors` POST to Mesa's loopback activity server (`/harness`), and — where
https→loopback fetches are blocked as mixed content — a hidden-iframe
navigation to the `mesa-snap:` scheme that Rust's `on_navigation` handler
intercepts and cancels. Both carry the per-run bearer token; Mesa verifies it
before storing a snapshot.

The embedded Pi agent ships with two bundled tools (`mesa-browser.ts`, loaded
via `--extension` like the activity and /goal extensions):

- `browse(url)` — Mesa mirrors the navigation into the visible harness
  (popping the wing open), waits for the rendered snapshot belonging to that
  navigation, and returns the **rendered page text** to the model — exactly
  what the user is watching, JS included. If no live harness materializes
  (no Pi surface mounted, or the legacy iframe fallback is active), Mesa
  answers with a native static fetch instead, and the tool result is
  explicitly labeled as a fallback the user is *not* seeing, so the agent
  cannot honestly overclaim.
- `browse_read()` — returns the harness's *current* rendered snapshot without
  navigating: how the agent re-checks a slow page or looks at whatever the
  user opened by hand.

Navigation mirroring also flows the other way: the webview reports real
navigations and SPA moves back to the harness address bar
(`mesa://harness-nav`), so the URL the user sees always matches the page.

### Isolation & sessions

The harness is fully isolated from the user's default browser (Chrome/Safari
profiles are never touched):

- The native harness webview and "open webview" windows use the app webview's
  own cookie storage, which persists across Mesa restarts (platform webview
  profile) — sign-ins made there stick, and because Pi's `browse` reads the
  rendered DOM of that same webview, the agent sees signed-in pages without
  any cookie sharing machinery.
- The static-fallback fetch and legacy reader mode share one native HTTP
  client with an in-memory cookie jar (reqwest `cookies` feature); that jar is
  memory-only and clears when Mesa quits.
- The harness webview's label (`pi-harness`) matches no capability window
  pattern, so remote pages get **zero** Tauri permissions; the reporter needs
  none (its transports are plain HTTP-to-loopback and a cancelled navigation).
  `on_navigation` confines the webview to http(s)/about/blob/data URLs. A
  contract test (`src/lib/harnessContract.test.ts`) pins all of this.

When no page body can be fetched at all, Mesa still archives a small HTML link
record with the failure message so the research trail is not lost.

The harness stack is deliberately dependency-free on the npm side: the native
webview + reporter, Tauri's `WebviewWindow` API, and the reqwest client
already in the Rust tree — no browser-automation or scraping npm packages, so
it adds no new supply-chain surface.
