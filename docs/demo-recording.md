# Demo recording

`scripts/demo/` re-records `docs/mesa-demo.webp`, the README demo, from the live
frontend so it follows the current interface (Studio by default).

## Storyboard

1. The workspace in several themes.
2. **01 Plan the day** — Shift+Tab overlay, calendar, then Pi answers "What's left for today?".
3. **02 Research the gap** — Pi moves into the workspace, reads a page in Mesa's browser, and runs
   Deep Research; the proposed notes are reviewed and applied.
4. **03 Watch the graph grow** — the new notes in the graph, hover cards, a pop-out window docked back.
5. **04 Find it again** — `/` search with arrow-key previews, then back to the daily note (loop).

## How it works

- The vault is the synthetic Tidewater fixture (`fixture.mjs`). People, notes, and data are
  fictional; papers are public citations with paraphrased summaries (`stage/pages.js`).
- `serve.mjs` runs a Vite server that swaps the browser demo vault for the fixture and exposes
  graph node positions. It changes no app source on disk. It fails loudly if its anchors in
  `src/lib/vault.ts`, `src/controllers/vault.ts`, or `src/components/GraphView.tsx` move.
- `mock.js` stands in for the Tauri IPC layer. `stage/pi.js` draws a scripted Pi TUI in Mesa's
  real terminal surface, and `stage/research.js` sends the Deep Research events. Mesa's real
  research controller validates the finish payload, so the script must keep passing that gate.
- `stage/` draws the desktop, window frame, pop-out windows, captions, keycaps, and cursor.
- Recording runs page time 4× slower (`timeshim.js` plus the CDP animation playback rate) so
  CPU-only Chromium captures smooth frames. `encode.mjs` maps the frames back to page time,
  crossfades the end into the first frame, and encodes with ffmpeg's `libwebp_anim`.

## Re-record

One-time tools, not project dependencies:

```bash
npm i --no-save playwright@1.56.1 @fontsource/source-serif-4@5
# ffmpeg with libwebp_anim must be on PATH
```

Without the font, Studio headings fall back to a generic serif.

```bash
# Optional: checkpoint screenshots without capture (fast)
SLOW=1 node scripts/demo/record.mjs tmp/demo-dry --no-capture --shots

# Capture (about 10 minutes), then encode
node scripts/demo/record.mjs tmp/demo-frames
node scripts/demo/encode.mjs tmp/demo-frames docs/mesa-demo.webp --quality 90
```

To inspect the stage interactively, run `node scripts/demo/serve.mjs` and open
`http://localhost:5174/__rec/index.html`.

## Before publishing

- Decode a few frames and look at every caption beat.
- Keep the file well under GitHub's 100 MB limit.
- Update the `docs/mesa-demo.webp` entry in `docs/binary-review.json` (bytes, SHA-256,
  `status: "pending"`). Only a human reviewer may mark it approved after checking every frame.
