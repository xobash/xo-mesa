# Living Graph

The graph is both note navigation and activity telemetry. Its defaults match
Obsidian's graph view: the same filters, the same force model, the same node
and link sizing, the same zoom, hover and drag behavior. Mesa adds a fit on
open, hover previews, image thumbnails and live file activity on top.

## Obsidian parity

The reference values below were measured from Obsidian's own graph renderer
and simulation worker. `src/lib/graphPhysics.test.ts`,
`src/lib/graphGeometry.test.ts` and
`src/components/GraphView.parity.test.tsx` hold each one.

| Area | Default behavior |
| --- | --- |
| Filters | Markdown notes, unresolved links and orphans are shown. Tags and attachments are off. "Attachments" covers every file that is not a Markdown note: other text documents (which keep their parsed links) and non-text files. Wiki links, embeds (`![[photo.png]]`), relative Markdown links and images (such as a link to `../b.pdf`) to those files are edges; a `#heading` or `#page=` suffix is ignored. A link to a hidden file is dropped, not shown as unresolved. |
| Forces | One model at every size. Pull to the origin on x and y with strength 0.1. Charge -1000 with a 30-unit minimum distance. Link springs with rest length 250 and strength `1 / min(link count of the two ends)`. A fixed 60-unit collision at strength 0.5. Velocity decay 0.4. |
| Sliders | Center force and link force are 0..1 on a log curve (defaults 0.52 and 1). Repel force is 0..20 and is cubed (default 10). Link distance is 30..500 (default 250). A slider change reheats the simulation to alpha 0.3 in place. |
| Seeding | A new node starts near the centroid of its placed neighbours. A node with none starts in a ring outside the placed graph, sized at 60 by 60 units per new node. The same graph seeds the same way every time. |
| Node size | Radius `clamp(3 * sqrt(links + 1), 8, 30)` world units times the node-size setting. Nodes grow in world units as the view zooms out (`sqrt(1 / scale)`), so they shrink on screen more slowly than the layout. Every note uses one fill; an unresolved link draws at half strength. |
| Links | One device pixel wide at thickness 1, drawn between the two circle edges. Arrows are off; when on they fade in between 0.3 and 0.8 device pixels per world unit. |
| Labels | Every visible node has a label below it, sized by its radius and wrapped at 300 world units. Labels are fully visible at one device pixel per world unit and gone at half that. The text-fade setting (-3..3) shifts the range by powers of two. At most 600 labels draw per frame. |
| Hover | The hovered or grabbed node takes the accent fill and an accent ring. Its links take the accent color. Everything outside its neighbourhood fades to 20% over about half a second. Its label is always shown, at a constant size when zoomed out. |
| Zoom | One wheel notch zooms by 1.5. The zoom eases 15% per frame. Zooming in holds the point under the cursor; zooming out holds the view centre. Limits are 1/128 and 8 device pixels per world unit, shared by Fit. |
| Pan | Dragging the background pans. A release while the pointer is still moving coasts and decays 10% per frame. |
| Drag | The grabbed node follows the pointer and keeps its grab offset. The simulation holds alpha 0.3 while the node moves, with no velocity cap and no change to any force. Release lets the energy decay; it adds no kick. |
| Rest | The simulation stops at alpha 0.001. The view then draws nothing until input, activity, a theme change or a setting change. |

Where Mesa differs on purpose:

- **Open.** Obsidian animates the whole layout for about five seconds. Mesa
  runs warm ticks before the first painted frame, so the graph appears laid
  out and only a short, low-energy tail remains visible. Mesa then fits the graph to
  the view; a small graph opens at one device pixel per world unit.
- **Graph settings saved before this model** used other units. They reset to
  the defaults once (`graphSettingsVersion`); other settings are untouched.
- **Click** opens the note in its own window. Double-click on the background
  fits the graph.
- **Previews, thumbnails and activity** (below) have no Obsidian equivalent.
- **Living motion** is an opt-in display setting, off by default.
- **All files** is an opt-in filter, off by default (see below).

## All files

The "All files" filter shows every file in the vault catalog as a node:
notes, other text documents, images, PDFs, audio and video, Office files,
archives, unknown binary files and files with no extension, in every
folder. While it is on, the Attachments and Orphans filters read as on and
are locked; Tags and Existing files only still apply to tag and unresolved
link nodes. Turning it on or off rebuilds the graph in place, like any
filter; it never changes how the graph opens.

Non-note files take one colour per kind (`--graph-node-image`, `-pdf`,
`-media`, `-office`, `-archive`; other files use `--graph-node-attachment`).
With only the Attachments filter on, every attachment keeps Obsidian's
single attachment colour. Clicking a file node opens the file in its own
window with the viewer for its type. Unlinked image files draw as dots; only
linked images get thumbnails.

The vault catalog leaves out names that start with a dot (`.obsidian`,
`.trash`, `.git`, `.env`), `node_modules`, Windows shell files
(`desktop.ini`, `Thumbs.db`), symbolic links and paths nested more than 255
folders deep. The same rule keeps them out of the file tree, search, sync and
every native read, so the graph does not show them either.

`npm run bench:graph -- <sizes> all-files` measures this view on a synthetic
vault where 45% of the files are not notes.

## Native Window

Drag the Graph view header to a workspace edge and release to tear it into a
native window. Drag that native OS title bar back over the main Mesa window and
release to dock it again; Graph has no separate pop-out or Dock buttons.

For fast first paint, the main window hands the new graph window a one-use
metadata snapshot containing files, parsed note links, and graph settings,
through IndexedDB (a 10,000-note vault is too large for localStorage). The
graph renders from that snapshot immediately. About 1.2 s later the window
refreshes the vault from disk in place: the shown notes, the selected note
and the laid-out graph stay on screen while the scan, the watcher and the
index check run, and only notes whose files changed are patched. If no
snapshot arrives, the window opens the vault from disk at once.

Every node takes part in one `d3-force` simulation: notes, unresolved links,
tags and attachments when their filters are on. Unlinked nodes have no springs,
so charge, the pull to the origin and collision alone place them around the
linked graph. Mesa has no separate orphan field or ring layer.

A node's size comes from its link count, in and out. Repeated links from one
file to the same target count once.

Only linked image attachments and notes with an embedded image receive graph
thumbnails, and only once the node is at least 4 screen pixels in radius.

## Living Motion

Living motion is an opt-in display setting ("Living motion" in graph
settings). It is off by default, because Obsidian's graph is still at rest.
With it on, and with the global Animations setting on and no reduced-motion
preference, Mesa adds render-layer motion that never reheats the simulation:

- a slow, sparse orbital drift and positional breathing, written only to
  `renderX`/`renderY` and capped at `(OVERLAP_GAP * k) / 2` so two nodes
  can never touch;
- a radius and opacity twinkle near 2 rad/s (period about 3 s; slower reads
  as static);
- a soft bloom behind the graph, scaled per theme by `--graph-bloom-alpha`,
  and the drifting backdrop layers behind the canvas.

Living frames run at 30 fps (20 fps above 4,000 nodes). They stop while the
window is unfocused or after 15 seconds without pointer, key or wheel input,
and resume on input; the backdrop layers pause with them. Reduced motion
turns the backdrop off. Hidden windows and off-screen canvases pause the loop.

With living motion off, the loop sleeps once the layout, the overlap cleanup,
the zoom ease, the highlight fade, pan coasting, activity and replay have all
settled. Pointer input, activity through its card fade, theme and System mode
changes, loaded thumbnails, settings, resize and Fit wake it.
`GraphView.test.tsx` and `GraphView.parity.test.tsx` cover sleep, wake and the
opt-in. Native frame and process CPU measurements are separate from this
regression coverage.

## Activity Cards

Live preview cards reuse the same `PreviewCard` component as hover previews.
Activity cards show:

- the rendered file preview
- a highlighted changed chunk when available
- a GPT-style line counter: `N files changed +added -removed`
- a deterministic face/status line for read/edit/write/create operations

Cards are placed by scoring nearby and corner positions. A candidate is heavily
penalized when it covers the active node, an active link, or another live card.
This keeps the flickering node and links visible while the preview is open.
Activity cards appear only for files that have graph nodes, so graph activity is
available for all graph text documents.

## Activity Flicker

The graph reacts to what the editor, file watcher, or Tauri activity bridge is
doing in the vault. Each read/edit/write/create on a file produces a **discrete
short blip** — not an accumulating glow. One keystroke (or one word read) = one
brief flicker that ends the moment the activity stops.

- `src/lib/activity.ts`: `bumpActivityAmount` sets intensity to `max(decayed
  residual, amount)` (capped at 1) so a burst of edits never piles into a
  long-tail glow. `decayActivity` uses a fast intensity time constant (~0.22s)
  and a slower rate time constant (~0.6s) so the blip is crisp but faster
typing still flickers faster.
- Render: the node gets a soft pulsing radial glow and its incident links
  flicker with a sine-modulated alpha. A live preview card appears with the
  changed snippet and a `N files changed +added -removed` counter.

This is the most prominent graph signal: it shows work observed by the editor,
file watcher, or activity bridge.

## Hover vs. Agent Activity (distinct code paths)

- **Hover highlight** follows Obsidian (see the table above). The open file
  takes the accent fill; its links are not emphasized.
- **Agent activity flicker** is Mesa's own signal. When the editor, file
  watcher or Tauri activity bridge reports a read, edit, write or create, that
  node gets a soft radial glow, its links flicker, and a live preview card
  appears. Active nodes are never dimmed by a hover.

## Settling

Content-only edits never add energy and never cut a settle short: the
simulation keeps its alpha. A save that changes only a file's size or
modification time does not rebuild the graph, so it never drops a node you
are dragging or ends a replay. A topology change (a node or link added or
removed) reheats to alpha 0.3, as Obsidian does for new graph data; kept nodes
hold their positions and new nodes are seeded beside them.

`resolveOverlaps()` runs only at idle (alpha 0.02 or lower, no grab), never
during drag or settle. At the default node size the 60-unit collision already
keeps every pair apart, so the pass moves nothing; it is the no-overlap
backstop for enlarged nodes.

The markdown body inside live cards is throttled separately from the canvas
draw loop, so fast typing or agent writes do not force a React re-render every
frame. Large graphs draw with viewport culling, one batched link stroke and
cached label wrapping. During zoom, pan, resize and node drag, thumbnails are
skipped; they return when the interaction settles.

## Large graphs

| Nodes | Rule |
| --- | --- |
| > 300 / > 800 | The open warm-up runs 56 / 42 ticks instead of 78, and leaves alpha 0.16 / 0.12 instead of 0.2 for the visible tail. Forces are the same at every size. |
| ≥ 500 | Node drag physics runs in the physics worker. |
| ≥ 1,000 | The open warm-up runs in the worker; the pane shows "Laying out N nodes…" and draws the graph once the same layout returns. The main-thread preparation runs in short steps (at most 65 ms each at 10,302 nodes, Measured), so the app stays responsive. |
| ≥ 2,000 | Settling after open, data changes and slider retunes also runs in the worker, including the idle overlap cleanup, and so does Animate's replay. The main thread copies each posted state and draws. |
| > 4,000 | Living-motion redraws use 20 fps instead of 30 fps. |
| ≥ 20,000 links | Plain links draw with WebGL2 on a canvas under the 2D canvas (owner sign-off 2026-11-19): where links cross, the crossing is slightly darker, as in Obsidian. Highlighted and active links, nodes and labels stay on the 2D canvas. Without WebGL2, with living motion, arrows or a non-default link thickness, plain links draw through a cached 2D layer instead. |

The warm-up anneals from alpha 1 down to the open alpha within its ticks.
The visible tail then decays quickly and reaches rest in under 90 frames,
moving a node by a few percent of the graph's spread at most. The result has
the same spread and link lengths as Obsidian's full 300-tick settle from the
same seed (`graphPhysics.test.ts`). The first drag, data change or slider
retune returns the simulation to the standard decay.
While a vault is opening, the graph waits for note metadata before that first
build. Vault open publishes the file catalog and the selected note before the
note index. The graph waits until the stored index is shown or, without one,
until indexing finishes or fails. The pane shows the indexing count in the
meantime and draws nothing from the previous vault. Building from the catalog
alone would paint and warm a partial graph, then rebuild and re-settle every
node when the notes arrive. A vault with no text files has nothing to wait
for.

The worker runs the same ticks and the same overlap passes in the same order
as the main-thread frame loop, so both paths end in the same layout
(`graphPhysics.test.ts`). Snapshot buffers are transferred to the worker and
state buffers back; neither direction copies them. Without `Worker`, or after
a worker error, the main thread keeps settling as before.

Hover and click hit-tests use a grid over frozen layout positions and the
node radius as drawn at the current zoom. The grid is rebuilt on the first
hit-test after the layout re-freezes; while nodes move, hit-tests scan all
nodes. Both pick the same node, and a target is never smaller than 9 screen
pixels.

At most 192 thumbnails stay cached; when every cached image was drawn in the
current frame, further nodes draw as dots instead of evicting.

Many-body charge, collision and link forces use flat-array copies of
d3-force 3.0.0's `forceManyBody`, `forceCollide` and `forceLink`
(`src/lib/graphForces.ts`). They build the same quadtree, visit it in the
same order and do the same arithmetic, so velocities match d3 bit for bit
(`graphForces.test.ts`) and the layout is unchanged. Measured at 10,302
nodes and 92,775 links in Node: charge 54 → 14.5 ms and collision 27.6 →
10.4 ms per tick, so the open warm-up fell from 3.3 s to 1.1 s and a settle
tick from about 85 to 36 ms. That warm-up runs in the worker, and a graph
laid out before (this session or an earlier one, kept in IndexedDB as
positions under a hash key, never names or paths) opens with its saved
layout at once. Seeding and the warm-up are deterministic, so the saved
layout is the one a new warm-up would produce.

A data change rebuilds the graph only when something the graph reads changes:
note titles, links, references, tags, aliases, first images, file paths and
times, note order, or the filters. A rebuild reuses each unchanged note's
resolved links while the note list, titles, aliases, files and filters stay
the same (`createGraphBuilder`), compares node ids and link pairs with
per-source sets, and builds hover lookups only when first needed. A save that
changes one note's links rebuilds in about 35 ms at that size (194 ms before).

Heavy-graph drawing (owner request "nothing still slow", 2026-11-19). WebKit's
2D canvas strokes links at a fixed cost per segment: 92,775 links took 26 to
40 ms a frame in Safari 27.2 however they were batched, sized or cached as
paths, so a 10,000-note graph dragged at 19 to 22 fps and panned at 33 fps.
The WebGL2 renderer keeps one buffer of node-index pairs, uploads node centres
and layout radii as a small texture when nodes move, and trims each line to the
two circle edges in the shader, so pan, zoom and the highlight dim are shader
values. Measured with the real GraphView in Safari 27.2 on a synthetic
10,000-note, 92,775-link vault: pan 62 fps, zoom 61 fps, drag 59 fps with
8 ms of work per frame. The 2D fallback layer is redrawn only when a plain
link moves and blitted otherwise; on WebKit it takes worker states at most
every 50 ms so frames keep their rate (35 states/s ran at 41 fps, 20/s at
59 fps in Safari). Link endpoints come from flat per-frame node arrays and
cached link indices instead of node-object reads (8 to 11 ms a frame before).

Simulations of 3,000 nodes or more spread the many-body pass over helper
workers inside the physics worker (up to six, leaving two cores free;
`graphChargeParallel.ts`). Every helper builds the same tree and applies a
range of nodes, so results are bit-identical to a serial tick; a range that
meets exactly coincident points makes the tick redo the pass serially.
Helpers build each tick's tree from positions while the worker runs the x, y
and link forces, and the collision pass skips subtrees whose highest point
index cannot interact (both exact). In Safari 27.2 at 10,023 nodes the open
warm-up took 649 ms in the worker and the graph showed 880 ms after mount
(153 ms of main-thread preparation in short steps, app responsive); dragging
received 60 layout states a second (35 before) at 59 to 62 fps.

A heavy first build resolves its notes in timer steps of about 12 ms, then
assembles; seeding, the simulation and the worker hand-off follow as separate
steps. The longest main-thread step of a heavy open was 30 ms at 10,000 notes
and 65 ms at 20,000 (Node; one 150 ms block at 20,000 before).

`npm run bench:graph` runs a seeded synthetic-vault benchmark at 1k, 5k, 10k
and 20k nodes (pass a comma-separated size list to change them; a third
argument sets link density, and 13 gives about 93,000 links at 10,000 notes). It measures
graph build, seeding, warm ticks, main-thread versus worker settle frames,
idle overlap passes, worker parity, hit-testing, the label pass and retained
heap in Node. It does not measure WebKit, WebView2 or WebKitGTK canvas drawing
or native frame times.

## External Activity

The Tauri activity bridge accepts activity payloads and forwards them into the
same tracker used by the editor and file watcher. Payloads can include:

- `path`
- `op`: `read`, `edit`, `write`, or `create`
- `status`
- `detail`
- `added`
- `removed`

`detail` is used for preview highlighting. `added` and `removed` drive the live
counter.

## Graph controls and replay

Fit and Animate own their pointer presses; neither starts a canvas drag.
Force sliders retune the existing simulation without rebuilding the layout.
Node size applies to drawing, hit tests and the idle overlap cleanup; it is
not a force and never reheats. The nearest node wins when hit targets overlap.
"Restore display defaults" returns the display and force settings to
Obsidian's defaults.

Animate admits nodes to the simulation in creation-time order. Each batch is
seeded like new graph data; hidden nodes and links exert no force. Playback is
finite, and Stop restores the full filtered graph. The camera gently follows
the growing bounds through settling. Drag, zoom or Fit returns camera control
to the user immediately. Changing filters or vault data ends the current
replay. When creation time is unavailable, the modification time or stable
path order is the fallback. Node dragging stays active as batches arrive.
Graphs of 2,000 nodes or more replay in the physics worker; the main thread
only seeds each batch and draws (about 0.5 ms per batch at 10,302 nodes).

## Native rendering and fit checks

Graph canvases use the system webview's ordinary 2D context. A missing context
shows a visible drawing status; a failed frame keeps the render loop alive and
clears its error status after a successful retry. The first fitted frame is
covered by a canvas-command regression that checks all node bounds. Native
acceptance must also confirm visible pixels, first-open fit, resizing, Fit,
zoom, node dragging, hover dimming and, with living motion on, its ambient
motion.

## Theme palette

System, Void, Darkroom, Graphite, Midnight, Ember, Dusk, Fjord and Paper share
semantic color tokens. Source-editor syntax follows each palette. File-type
badges retain stable extension hues and theme lightness; green-hued extensions
use zero saturation so SVG/TXT badges do not tint the workspace green. Both
theme pickers show surface/accent swatches. Saved and standalone-window theme
IDs are validated against the same supported list.
