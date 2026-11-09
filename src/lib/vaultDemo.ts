import type { VaultFile } from "../types";
import { toVaultFile } from "./vaultPaths";

/** In-memory demo vault for the browser preview (no Rust build required). */
export const DEMO_ROOT = "mesa://demo";

export const SPARK_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160' viewBox='0 0 240 160'>
      <defs><radialGradient id='g' cx='50%' cy='45%' r='60%'>
        <stop offset='0%' stop-color='#7ae6a8'/><stop offset='60%' stop-color='#58a6ff'/>
        <stop offset='100%' stop-color='#10141c'/></radialGradient></defs>
      <rect width='240' height='160' fill='#0d1017'/>
      <circle cx='120' cy='72' r='46' fill='url(#g)'/>
      <g stroke='#58a6ff' stroke-width='2' opacity='0.7'>
        <line x1='120' y1='72' x2='40' y2='30'/><line x1='120' y1='72' x2='205' y2='40'/>
        <line x1='120' y1='72' x2='60' y2='130'/><line x1='120' y1='72' x2='195' y2='125'/></g>
      <g fill='#cbe6ff'><circle cx='40' cy='30' r='6'/><circle cx='205' cy='40' r='6'/>
        <circle cx='60' cy='130' r='6'/><circle cx='195' cy='125' r='6'/></g>
    </svg>`
  );

export const DEMO: Record<string, string> = {
  "Welcome.md": `# Welcome to Mesa

This demo vault shows the core Mesa workflow. The desktop app opens your own
folders directly and keeps notes as plain files on disk.

Start here:
- [[Graph View]] — the living map of the vault
- [[Workspace]] — snap, close, pop out, and re-dock views
- [[Overlay and Pi]] — Shift+Tab tools plus the Pi terminal
- [[Sync and Saved Webpages]] — LAN/Tailscale sync and local HTML pages
- [[Keystroke Flicker]] — watch nodes light up as you type
- [[Markdown Basics]]

![[spark.svg]]

Keyboard path:
- <kbd>j</kbd>/<kbd>k</kbd> move through notes
- <kbd>h</kbd>/<kbd>l</kbd> move focus
- <kbd>/</kbd> searches
- <kbd>Shift</kbd>+<kbd>Tab</kbd> opens the overlay
- <kbd>Cmd/Ctrl</kbd>+<kbd>Left Shift</kbd>+<kbd>Space</kbd> opens Pi
`,
  "Graph View.md": `# Graph View

The graph is more than dots and lines. Nodes can render an embedded image as a
thumbnail, links thicken with connection strength, and active notes *flicker*.
When animations are enabled, nodes subtly breathe, twinkle, and react to panning
without destabilizing the layout.

Related: [[Keystroke Flicker]], [[Hover Preview]], [[Workspace]], [[Project Mesa]].

<div style="padding:8px 10px;border-left:3px solid #58a6ff;background:#161b22;border-radius:6px">
  HTML renders inline too — this callout is raw &lt;div&gt; markup.
</div>
`,
  "Workspace.md": `# Workspace

Mesa is a constrained workspace for the current vault. Open a file, Preview,
Graph, Tasks, or Pi and the first view fills the empty workspace. Add another
view and Mesa splits the space only after something is already open.

Drag view headers to swap, snap, pop out, or dock views back in. Closing a view
lets the remaining content fill the available space.

Related: [[Graph View]], [[Overlay and Pi]].
`,
  "Overlay and Pi.md": `# Overlay and Pi

Press <kbd>Shift</kbd>+<kbd>Tab</kbd> for Mesa's overlay: calendar, search, Pi,
scratchpad, whiteboard, gallery, and overlay settings.

Pi is a terminal, not a chat panel. Press
<kbd>Cmd/Ctrl</kbd>+<kbd>Left Shift</kbd>+<kbd>Space</kbd> to open the dedicated
Pi overlay. Mesa gives Pi path-only context for the active workspace so tokens
are spent only when you use Pi.

Related: [[Workspace]], [[Sync and Saved Webpages]].
`,
  "Sync and Saved Webpages.md": `# Sync and Saved Webpages

Sync is designed for your own devices. Turn on Sync, set one sync key, receive
from a device, then add nearby Mesa devices when they appear on LAN or
Tailscale. Discovery shares device metadata only; vault data still needs the
sync key.

Saved HTML files open as local pages so sibling asset folders can load like they
would in a browser. Source mode is still available when you need to inspect the
captured file.
`,
  "Keystroke Flicker.md": `# Keystroke Flicker

When you edit a note, its node in the graph reacts to your typing: the more
frequent the keystrokes, the faster and brighter it flickers. It decays back to
calm a moment after you stop.

See it next to [[Graph View]].
`,
  "Markdown Basics.md": `# Markdown Basics

Mesa supports standard Markdown plus [[wiki links]].

- **bold**, *italic*, \`code\`
- Lists, quotes, tables
- Images: ![[spark.svg]]

Back to [[Welcome]].
`,
  "Ideas/Project Mesa.md": `# Project Mesa

A note-taking app where the graph is alive. Links: [[Graph View]],
[[Hover Preview]], [[Keystroke Flicker]], [[Workspace]].
`,
  "Ideas/Hover Preview.md": `# Hover Preview

Rest the pointer on any node for a moment and a preview card fades in with
the note's rendered Markdown — images and HTML included.

Connected to [[Graph View]] and [[Project Mesa]].

![[spark.svg]]
`,
  "assets/spark.svg": "<!-- demo image, served from memory -->",
};

export function demoFiles(): VaultFile[] {
  return Object.keys(DEMO).map((rel) => toVaultFile(DEMO_ROOT, rel));
}
export function demoRead(rel: string): string {
  return DEMO[rel] ?? "";
}
export function demoWrite(rel: string, content: string): void {
  DEMO[rel] = content;
}
