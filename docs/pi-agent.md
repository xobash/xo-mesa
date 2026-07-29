# Pi Agent

Pi is Mesa's lightweight agent harness. Press `Cmd/Ctrl + Left Shift + Space`
to open the dedicated Pi overlay. Pi is still available from the Shift+Tab
overlay dock, and it can be placed into the main workspace or torn into its own
native window by dragging its `Pi agent` title bar to a workspace edge and
releasing. The surface launches the actual `pi` CLI in a PTY, not a custom Mesa
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

Mesa keeps one live Pi PTY session across every Pi surface: the
floating Pi window (opened by the dedicated shortcut, and reused as the
fallback surface when a feature needs Pi or a native pop-out fails), the
Steam-style overlay Pi window, the workspace pane, and the popped-out Pi OS
window. All in-window floating Pi surfaces render one shared floating-window
implementation with the same combined title bar (Pi label, terminal status,
research/workspace/browser/close tools), drag-to-move, drag-to-edge tear-off,
and corner resize — they cannot drift apart. Switching between the in-window
surfaces reattaches the same xterm instance instead of spawning a new Pi
process, because they share one JS module singleton within that window.

Popping Pi out into its own OS window is a different kind of transition: a
Tauri `WebviewWindow` is a separate JS realm, so it can't see that singleton
at all. To avoid silently orphaning the running `pi` process and starting a
second, contextless one, Mesa hands the live session id to the new window
through its launch URL (`openAgentWindow` in `store.ts`); the new window
atomically claims the backend session with `terminal_attach` and reattaches its
own xterm instance to that
same session (`adoptSharedPiSession` in `AgentPanel.tsx`) instead of calling
`terminal_start`. Rust retains a bounded output history for each PTY. The new
window subscribes to live output first, requests `terminal_snapshot`, replays
its ordered resize/output timeline, then drains only events with a newer
sequence number. Preserving the grid-size timeline matters for full-screen
terminal UIs: replaying cursor-up/rewrite bytes at only the new window's width
changes line wrapping and leaves stale or duplicated lines. This preserves the
visible conversation without losing or duplicating bytes during the handoff.
Because Rust's `TerminalState` and the `terminal://output` event are app-global
(not per-window), both windows can stay attached to the same live session
during the handoff.

The detached surface is Mesa's complete `AgentSurface`, not a stripped-down
terminal transcript. It keeps the context strip, Deep Research, workspace and
browser controls, the xterm input path, and the exact same injected session
context and extensions. Mesa creates it as a decorated native Tauri
`WebviewWindow` and makes the OS window visible immediately. `AgentSurface`
uses the authoritative vault path in the launch URL to adopt the existing PTY
without waiting for its separate store to finish a full vault scan. The source
surface remains mounted until the child emits `mesa://agent-window-ready`, so a
failed or slow adoption cannot discard the working terminal. On macOS the native traffic-light controls are retained with
an overlay-style title bar and hidden duplicate title; Windows and Linux retain
their ordinary OS window frame. Mesa's Tauri capability explicitly permits the
post-handshake `setFocus`, `close`, and title-bar drag operations; the
base read-only window permission set is not sufficient for those mutations.
Once PTY adoption succeeds, focus and the initial context mirror are
best-effort conveniences: failure cannot close the working child. Native
dock-back is also disarmed until the user presses the Pi drag region and makes
a sustained native drag (at least three move events spanning 80ms). Ordinary
click/focus interaction disarms without movement, and OS startup frame
corrections are ignored even if one exceeds the normal distance threshold.
The ready acknowledgement is broadcast app-wide. If it is delayed or lost,
Mesa keeps both surfaces alive and reports an unconfirmed handoff; it never
closes a visible child on a timer. Only an explicit native creation error is
eligible for automatic child cleanup.
See Tauri's
[WebviewWindow API](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/)
and [window customization guide](https://v2.tauri.app/learn/window-customization/).

A live Pi session is never silently restarted just because the workspace
context drifted (the user switched files) — relaunching would drop the
conversation and shed any session-scoped launch env a feature injected at
spawn (e.g. Deep Research's read-only write-block). Instead, the main Mesa
renderer publishes the same path-only context shown in the context strip to
the authenticated loopback activity bridge. The bundled `mesa-context`
extension reads it before every agent turn and appends an authoritative
`Live Mesa workspace context` block to that turn's system prompt. Detached
AgentSurface renderers receive the same typed update over an app-local Tauri
event, so their visible strip follows the main workspace too. The session
restarts only on an explicit feature request (the shared-session restart bridge
in `lib/piSessionBridge.ts`), a vault change, or an app restart.
Mesa serializes Pi startup, awaits the previous Tauri output listener cleanup,
and accepts terminal output only when both the session id and listener
generation match the active shared session. That prevents stale PTY output from
rendering twice into the shared xterm during overlay/workspace switches or
feature-requested restarts.

PTY dimensions have one owner at a time. `terminal_start` assigns the spawning
Mesa window; `terminal_attach` atomically transfers ownership when Pi tears out
or docks back; focus changes reclaim it for the active Mesa surface. Resize
bursts from FitAddon/ResizeObserver/font changes run through a serialized
latest-wins queue, and the native backend ignores resize calls from non-owners.
This prevents two webviews—or two out-of-order async calls—from fighting over
one PTY width and breaking Pi's TUI redraw arithmetic. Snapshot replay is the
one path allowed to resize the grid without telling the PTY, because it is
reproducing the historical timeline; it therefore always reconciles the grid
with the PTY when it finishes, since a real resize can land during the replay
and a later `fit()` cannot detect it.

Every byte Mesa reads from the PTY is decoded through one incremental UTF-8
decoder per session. A read returns whatever the kernel had buffered, so a
multi-byte character routinely straddles two reads; decoding each read on its
own replaced one character with several replacement characters and made the
line wider than Pi wrote it. Pi's redraw then landed a row below its previous
render and left it on screen — text appearing twice, with the first word of a
wrapped line stranded on its own row. Mesa holds an incomplete trailing
sequence back until the next read instead, so the emulator lays out exactly the
columns Pi counted.

Mesa caches the resolved Pi executable after the first successful launch and
starts the PTY at the terminal's current columns/rows to avoid a visible resize
round trip during startup.

On Windows, Mesa prefers a real `PATHEXT` launcher (`.exe`, `.com`, `.cmd`,
`.bat`) over a same-name extensionless file, because npm and Hermes installs
often ship Unix-style `pi` scripts beside Windows launch shims. If Mesa resolves
an extensionless Node shebang script it launches it through `node.exe`; if only
the Windows wrapper exists it launches that wrapper through `cmd.exe`.

Mesa does not fake a transcript with styled text. It also does not substitute
Terminal.app, Windows Terminal, cmd.exe, or PowerShell for the detached Pi
surface. Those programs can attach to a byte stream, but they cannot host
Mesa's context strip, Deep Research and browser controls, app state, or
review-before-apply workflow. Mesa therefore owns the one PTY process and
renders it with xterm.js inside a real movable/resizable OS window.

Mesa launches `pi` directly in the current vault folder. The terminal receives
an initial path-only fallback through Pi's `--append-system-prompt` startup
hook and mirrors the launch values through `MESA_*` environment variables:

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
The immutable launch values remain useful to tools that read process env, but
the per-turn `mesa-context` block is the model-facing authority after the
workspace changes. When Pi is popped into its own OS window, Mesa carries the
selected file in the launch URL for first paint, then replaces that snapshot
with every main-workspace context update while adopting the already-running
PTY. It never restarts Pi merely to refresh context.

The dedicated shortcut overlay uses one title bar for its title, terminal
status, and controls. While that bar is dragged to a workspace edge Mesa shows
`Release to move outside Mesa`; releasing there opens the native window under
the same grabbed point on the desktop and hands off the live Pi session. No
separate pop-out button is required. The detached Pi surface has real native
window decorations; on macOS its combined Pi bar is also marked with Tauri's
`data-tauri-drag-region` inside the overlay title bar, leaving room for the
native traffic lights. Drag that Pi bar over the main Mesa window and release
to dock it; there is no permanent Dock button.

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
rename/read-back guarantees apply to it.

For text files that is fine: a text tool round-trips text, and Pi editing notes
is the intended workflow. For a binary file it is not an edit but destruction.
`write`/`edit`/`apply_patch` carry string content, so reaching disk means a
UTF-8 decode/encode cycle that mangles every byte sequence which isn't valid
UTF-8. On a PDF, one altered byte invalidates the xref table and the document
stops opening.

So Mesa blocks those tools on binary paths. The same pre-execution `tool_call`
hook the activity extension already uses returns `{ block: true, reason }` and
the write never happens. The reason string tells the model the two routes that
do work — a format-aware tool via `bash` (qpdf, ImageMagick, a Python library),
or Mesa's own editor — because without that a capable agent just retries the
same corrupting write. `bash` itself is never blocked, so agent-driven binary
work still functions; only the text-encoder path is closed. Reads are never
blocked either.

Full detail — the blocked extension list, the lockstep contract between the
extension and its tested reference in `src/lib/agent.ts`, and why the previous
snapshot-based safety net was removed — is in
[vault-safety.md](vault-safety.md).

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
Both variants are resizable by dragging the wing's outer edge. An inline wing
is capped at half of the bounded Pi surface, preserving at least half for a
usable terminal; opening Browser and Deep Research is mutually exclusive only
in that bounded mode. Floating slide-out Pi windows may keep both external
wings open because they do not consume terminal width.

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
  blocked. The browser demo (no Rust) always uses the legacy path. Reader
  mode's fetch (`browse.rs`) deliberately sends a bare, generic user agent so
  UA-sniffing sites serve their simplified/legacy HTML variant (easier for the
  static parser to reconstruct) — this is why a page that falls into reader
  mode can visibly look "old" (Google's classic bare-bones layout is the
  textbook example); it is not a caching or rendering bug, it is that UA.
- One failed `harness_navigate` used to permanently downgrade the whole wing
  session to that legacy path over what is usually a one-off hiccup (the
  loopback activity server was still starting, a transient wry/webview-runtime
  error) rather than a real platform limitation. `harness_navigate` now waits
  briefly for the activity server if it isn't up yet and recreates a
  misbehaving existing webview once before erroring; the frontend also retries
  once before giving up. If native mode still downgrades, the status row (only
  shown once nativeOk is confirmed false) offers a one-click "Try live view
  again" instead of requiring the wing to be closed and reopened.

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
