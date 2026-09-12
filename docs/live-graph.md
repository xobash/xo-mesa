# Living Graph

The graph is both note navigation and activity telemetry. Like Obsidian, it can
render the vault as a single force-directed field: every supported text document
is present, and the Attachments filter admits non-text files into that same
simulation. Linked attachments sit in the connected cluster; unlinked
attachments and unlinked notes settle as degree-0 orphan nodes around it.

## Native Window

Drag the Graph view header to a workspace edge and release to tear it into a
native window. Drag that native OS title bar back over the main Mesa window and
release to dock it again; Graph has no separate pop-out or Dock buttons.

For fast first paint, the main window hands the new graph window a one-use
metadata snapshot containing files, parsed note links, and graph settings.
The graph renders from that snapshot immediately, then refreshes the vault from
disk in the background so the native window converges on current filesystem
state without showing an empty canvas during the initial scan.

All text-document nodes participate in the same `d3-force` simulation. Linked notes
are pulled together by links; unlinked notes have no links, so they settle as
force-directed orphan nodes under the same charge, centering, collision, zoom,
fit, hover, and drag rules as the rest of the graph. Mesa does not place
unlinked notes into a separate deterministic field or donut layer.

Mesa sets a node size from its resolved atomic-link degree. A file with more
linked file relationships is larger. A file with fewer relationships is smaller.
Repeated links from one file to the same target are one graph relationship.

When Attachments is enabled, non-text files use the same force, fit, hover,
and drag rules instead of a static decorative ring. To keep large vaults
responsive, only linked image attachments receive graph thumbnails; unlinked
attachments render as ordinary dots.

## Living Motion

The graph has two kinds of motion:

- Layout motion from `d3-force`, used only while the graph is settling or a node
  is being dragged.
- Render-layer motion, used for the ambient “living” feel.

Ambient motion never reheats the force simulation. Mesa keeps stable layout
positions, then renders deterministic `renderX`, `renderY`, and `renderRadius`
offsets at an adaptive cadence. The feel is tuned close to Obsidian — a
near-still graph — while still reading as alive: a slow, sparse orbital drift;
a dark, soft bloom (not cluster glow) behind the main cluster; and a gentle
radius + opacity twinkle as the visible life signal. **Twinkle frequencies must
stay perceptible (≈2 rad/s, period ~3s); a 12s-period sine reads as static, not
twinkling, no matter the amplitude** — that was the root cause of the recurring
"nodes don't twinkle" reports. Positional drift stays slow (near-still
Obsidian layout) while the non-positional twinkle (opacity is the primary
zoom-independent signal, since radius motion is sub-pixel on small notes at
fit-zoom) carries the living feel at any zoom. Per-axis frequencies are
deliberately different so radius and opacity don't sync (organic, not a
uniform pulse). The radius twinkle is non-positional and can never cause
overlap. Positional breathing is screen-constant but capped at
`(OVERLAP_GAP*t.k)/2` so two rendered nodes can never touch. The global
Animations setting disables all of it.

The main-cluster bloom uses the theme token `--graph-bloom-alpha`: Void keeps
the full bloom, while System and Darkroom deliberately run a lower multiplier so
their graph backgrounds do not read as a strong glowing halo.

At fitted zoom, the graph must stay readable enough to inspect and grab nodes.
Base links use visible graph-token alpha, linked notes use a green-grey
Obsidian-like dot, isolated notes stay dimmer but legible, and attachment dots
use a warm yellow field. Nodes keep a visible opacity floor even while
twinkling. Hover focus emphasizes a node's neighborhood without making the rest
of the graph disappear, so topology remains visible while a hover preview is
open.

Ambient redraws are an explicit draw reason, not a side effect of the graph
being marked dirty. When animations are enabled and nodes are visible, the
settled canvas must continue drawing at the living cadence after pointer
interaction ends; otherwise render-only breathing/twinkle appears to freeze even
though the force layout is correctly settled.

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

This is deliberately the loudest thing on the graph — it is the capability Mesa
has over Obsidian: the graph visibly reacts to what the agent is working on.

## Hover vs. Agent Activity (distinct code paths)

Mesa deliberately separates two kinds of "highlight":

- **Hover/open-file highlight** is intentionally very subtle. Hovering a node
  only slightly lifts its incident links above the base color (faint flicker
  tint), and the open document's links get a touch more so the current file
  stays findable. The per-node hover ring is thin and low-alpha. This is purely
  a visual aid, not telemetry.
- **Agent activity flicker** is the loud path and stays loud. When the editor,
  file watcher, or Tauri activity bridge reports a read/edit/write/create on a
  markdown note, that node's links flicker, the node gets a soft radial glow,
  and a live preview card appears. This is the capability Mesa has over
  Obsidian: the graph visibly reacts to what the agent is doing in the vault's
  notes.

The two paths are decoupled so toning down hover never weakens agent telemetry.

## Smoothness

Content-only edits do not reheat the force simulation. Existing node velocity is
zeroed on non-topology updates, while actual topology changes still settle with a
small alpha. This prevents the slow counter-clockwise drift that happened when
editing or reading a file.

**Dragging a node is a legitimate reheat** (user interaction, not ambient motion
— the "never reheat" rule above is about ambient living motion only; Obsidian
reheats on drag too). On first move the sim is pinned to an `alphaTarget` of
~0.3 (d3/Obsidian standard) so the grabbed node's cluster follows the pointer
in real time, and the grabbed node is rendered at its exact layout position with
no ambient wobble/twinkle so it tracks the cursor 1:1. `velocityDecay` (~0.38,
tiered) is slightly looser than d3's 0.4 default for a satisfying release exhale;
neighbour velocities are capped uniformly (4/5/6 by graph size) so a grabbed
exterior node can't berserk the cluster. **Link strength is degree-scaled**
(`1/min(deg(source),deg(target))`, d3's default) so a high-degree hub's links
are individually weak and don't fling its cluster — a flat strength was the
main cause of hub-drag jitter. **`resolveOverlaps()` runs only at idle, never
during drag/settle** — it is a hard per-frame positional snap that would fight
the link force during a hub drag (links pull neighbors in → resolver snaps them
out → jitter). During drag, `forceCollide` (iterative, velocity-aware) handles
collisions smoothly, the way Logseq/Athens/Foam (all d3-force clones) and
Obsidian do; the resolver takes over alone at rest as the no-overlap backstop.
`resolveOverlaps()` still guarantees no overlap at rest.

The markdown body inside live cards is throttled separately from the canvas draw
loop, so fast typing or agent writes do not force a React re-render every frame.

Large graphs are drawn with viewport culling, batched link strokes, cached label
ordering, cached activity lookups, and throttled ambient frames. During zoom,
pan, resize, and node drag, Mesa enters a fast draw path that temporarily skips
labels and thumbnails so interaction stays smooth; full visual detail returns
after the interaction settles.

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
Fit and manual zoom share a low minimum scale so large vaults fit on screen.
Link strength scales with endpoint degree without a positive minimum that
overrides low slider values. Node size applies to drawing, hit tests, collision,
and final overlap cleanup. The nearest node wins when hit targets overlap.
Dragging preserves the grab offset, and release lets the existing energy decay
without adding a stronger kick for hubs.

Animate admits nodes to the simulation in creation-time order. Each new batch
appears near already-visible neighbors; hidden nodes and links exert no force.
Playback is finite, and Stop restores the full filtered graph. The camera
gently follows the growing bounds through settling. Drag, zoom, or Fit returns
camera control to the user immediately. Changing filters
or vault data ends the current replay. When creation time is unavailable, the
available modification time or stable path order provides the fallback. Force sliders keep the same scale throughout playback, and node dragging
remains active as batches arrive. This
replay is independent of Mesa's ambient twinkle and activity previews.
