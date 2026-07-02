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
Pi overlay, and the Steam-style overlay Pi pane. Switching between those Mesa
surfaces reattaches the same terminal instead of spawning a new Pi process.
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

Page loading is two-tier in the desktop app:

1. Mesa fetches the page natively first (Rust `browse_fetch`, reqwest — no
   CORS) and inspects the response headers. Sites that allow framing load in
   the iframe directly, full fidelity.
2. Sites that forbid framing via `X-Frame-Options` / CSP `frame-ancestors`
   (google.com, github.com, most login pages — previously a silent white
   rectangle) render in a sandboxed srcdoc **reader mode**: a `<base>` tag
   resolves the page's own assets and an injected bridge forwards link clicks
   and GET form submissions back to the harness, so search-and-browse keeps
   working. Reader frames get no `allow-same-origin`, so page scripts stay
   isolated from Mesa. The ⧉ button opens the real site in a separate Mesa
   webview window when full fidelity is needed.

- search terms open a DuckDuckGo search URL
- full URLs open directly
- Archive saves the current page into `Web Archives/` inside the active vault,
  reusing the natively fetched body so it works even for sites the webview
  cannot fetch

### Pi can browse through the harness

The embedded Pi agent ships with a bundled `browse` tool (`mesa-browser.ts`,
loaded via `--extension` like the activity and /goal extensions). When Pi
calls it, Mesa's loopback server fetches the page natively and **mirrors the
navigation into the visible harness**, popping the wing open — the harness is
the user's window into what the agent is reading. The tool returns the page's
text content to the model. Users can drive the same harness by hand; both go
through the same fetch path.

### Isolation & sessions

The harness is fully isolated from the user's default browser (Chrome/Safari
profiles are never touched). Two storage domains exist:

- Direct-iframe pages and "open webview" windows use the app webview's own
  cookie storage, which persists across Mesa restarts (platform webview
  profile) — sign-ins made there stick.
- Reader-mode and Pi's `browse` fetches share one native HTTP client with an
  in-memory cookie jar (reqwest's built-in `cookies` feature; no new crates).
  Sessions established there persist for the whole app run — and are shared
  between the user's harness and Pi's tool, so Pi keeps working with whatever
  the user signed into — but the jar is deliberately memory-only and clears
  when Mesa quits.

When no page body can be fetched at all, Mesa still archives a small HTML link
record with the failure message so the research trail is not lost.

The harness stack is deliberately dependency-free on the npm side: a plain
iframe, Tauri's `WebviewWindow` API, and the reqwest client already in the
Rust tree — no browser-automation or scraping npm packages, so it adds no new
supply-chain surface.
