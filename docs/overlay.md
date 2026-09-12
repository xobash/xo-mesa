# The overlay

Shift+Tab fades a full-screen work layer in over the vault. A dock along the
bottom opens floating windows — **Calendar**, **Search**, **Pi**, **Research**,
**Tasks**, **Scratchpad**, **Whiteboard**, **Gallery**, **Settings** — each
movable, resizable, closable, and resettable. Esc closes the overlay. The dock
is for temporary tools, not permanent chrome. Every dock button reports whether
its window is open. Its icon is decorative; assistive technology receives the
surface name and open/close action instead.

Focused floating-window title bars are also keyboard geometry controls: Arrow
keys move a window and Shift+Arrow resizes it, with the same viewport limits as
dragging. Close controls name the exact surface they close. When Pi or Deep
Research owns the focused transfer bar, `Ctrl/Cmd+Shift+Enter` tears it out or
docks it back. These shortcuts appear in the focused bar's hint.

Shift+Tab toggles immediately on the first keydown of each physical Tab press,
from any focused Mesa surface, including editors, search fields, and Pi. The
shortcut stays claimed until Tab is released, so a held Tab cannot immediately
close the overlay when Shift is released first. If the webview misses that Tab
release, the next non-repeat physical Tab press recovers instead of leaving the
overlay shortcut stuck. Releasing either Shift or Tab ends the press; neither
key release can trigger a second toggle.
The overlay focus trap defers this exact chord, so closing uses the same
physical shortcut path as opening. Other Tab presses still cycle focus inside
the overlay.

On desktop startup Mesa explicitly focuses both the native window and the main
webview after its first paint. This keeps renderer-owned shortcuts such as
Shift+Tab and `/` available immediately, even when macOS activates the native
window before its webview has become the first responder. Pi's native global
shortcut is a separate path and does not depend on renderer focus.

When the overlay is already open, Search routes into the overlay's own Search
window rather than opening the main-workspace search modal underneath it. Search
keeps reusable saved-search shortcuts in local browser storage, exposes common
file-type filters, preserves the current text term when a filter is applied,
and explains incomplete or name-only coverage while indexing catches up.
When Deep Research starts from the overlay while Pi is cold, Mesa also opens
the overlay's own Pi window as the bootstrap host instead of starting Pi in a
separate floating surface behind the overlay.

Deep Research opened from Pi starts as a downward composer contained within
the Pi surface, so its controls remain above the dock/footer. After submission,
the live research surface uses the right-side wing. Dragging its header tears
it into a separate decorated Mesa native window; dragging that title bar back
over Mesa docks the research view again. The native view observes the same run
owned by the main Mesa renderer and never starts a second Pi session.
Only one Deep Research presentation is visible: opening it in another host
transfers that same run instead of stacking a duplicate window. Browser
navigation during a run keeps Research open and respects a browser wing the
user closed.

## Where each surface keeps its data

This is the part worth reading before you trust a surface with something.
Mesa's promise is that your content is plain files in the folder you chose —
and it holds for most of the overlay, but not all of it.

| Surface | Lives in | Syncs to your other devices | In search / the graph |
|---|---|---|---|
| Calendar | `calendar.json` at the vault root | yes | — |
| Tasks | checkbox lines in your notes | yes | yes |
| Search, Gallery | reads the vault; Search saves shortcuts in browser storage (`mesa:savedSearches:v1`) | — | — |
| Pi, Research | the vault (notes it writes) | yes | yes |
| **Scratchpad** | browser storage (`mesa:scratch:<date>`); optional Markdown file in the vault | only after you save it into the vault | only after you save it into the vault |
| **Whiteboard** | browser storage (`mesa:whiteboard`); optional PNG file in the vault | only after you save it into the vault | only after you save it into the vault |
| Window layout | browser storage (`mesa:overlayWins`) | no | — |

The Scratchpad and the Whiteboard are scratch space on purpose. They are the
back of an envelope: instant, per-device, no file created in your vault for a
half-thought or a diagram you drew while thinking. The cost is real and worth
stating plainly — that content does not sync, does not appear in search or the
graph, gets no verified-write recovery, and is gone if browser storage for the
app is cleared. Use **Save into vault** when you want to keep an item. Mesa
creates a new verified file. It does not replace an earlier export:
Scratchpad saves Markdown in `Scratchpad/` and Whiteboard saves PNG files in
`Whiteboard/`. The new file then syncs, appears in the file tree, and is
available to the normal vault tools.

### When storage runs out

Browser storage is one shared, finite budget for the whole app. Mesa does two
things so a scratch surface can never quietly cost you something:

- **A failed save is visible.** If a write does not stick, the surface says so
  instead of accepting the keystroke and dropping it. The content stays on
  screen; what you are being told is that it will not survive a relaunch. The
  remedy is in the message: clear the whiteboard, clear an old scratchpad day,
  or move the content into a note.
- **One surface cannot evict the app's own state.** A single entry is capped
  well below the origin quota, so an ever-growing whiteboard can never crowd
  out your settings, your theme, or your recent-vault list. An oversized write
  is refused, and the last good version stays intact.

The rules live in `src/lib/localNotes.ts` and are pinned by
`src/lib/localNotes.test.ts`, including the quota-error spellings that differ
across WebView2 (Windows), WKWebView (macOS), and WebKitGTK (Linux).

## Calendar

Day / week / month / year views with holiday and event banners. Events are
stored in `calendar.json` at the vault root, so they travel with the vault and
sync like any other file. Keyboard behavior is documented in
[keyboard-navigation.md](keyboard-navigation.md).

## Gallery

A grid of every image in the vault, read live from the current scan. It stores
nothing of its own.

## Pi and Research

The overlay's Pi window renders the same single Pi session as every other Mesa
surface — never a second process. See [pi-agent.md](pi-agent.md) and
[deep-research.md](deep-research.md).
