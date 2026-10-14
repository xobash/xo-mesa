// Turns frames from scripts/demo/record.mjs into the looping README WebP.
// Frames are resampled to a constant rate in page (virtual) time, the end
// crossfades into the opening frame, and ffmpeg's libwebp_anim encodes it.
// Usage: node scripts/demo/encode.mjs [framesDir] [out.webp] [--fps 30] [--quality 75]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const fps = flag("fps", 30);
const quality = flag("quality", 75);
const src = path.resolve(args[0] ?? "tmp/demo-frames");
const out = path.resolve(args[1] ?? "docs/mesa-demo.webp");
const crossfade = 0.7;

const { frames, slow = 1 } = JSON.parse(fs.readFileSync(path.join(src, "index.json"), "utf8"));
const t0 = frames[0][1];
const times = frames.map(([, t]) => (t - t0) / slow);
const total = times.at(-1) + 0.5;

// The newest captured frame at or before each output tick.
const lines = [];
let j = 0;
for (let k = 0; k < Math.floor(total * fps); k++) {
  while (j + 1 < times.length && times[j + 1] <= k / fps) j++;
  lines.push(`file '${path.join(src, frames[j][0])}'`, `duration ${(1 / fps).toFixed(6)}`);
}
lines.push(`file '${path.join(src, frames[j][0])}'`);
const list = path.join(src, "list.txt");
fs.writeFileSync(list, lines.join("\n") + "\n");

const length = Math.floor(total * fps) / fps;
const filter =
  `[0:v]fps=${fps},format=yuv420p[main];` +
  `[1:v]fps=${fps},format=yuv420p,trim=duration=${crossfade + 0.1}[head];` +
  `[main][head]xfade=transition=fade:duration=${crossfade}:offset=${(length - crossfade).toFixed(3)}[v]`;
const ff = spawnSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "warning",
  "-f", "concat", "-safe", "0", "-i", list,
  "-loop", "1", "-i", path.join(src, frames[0][0]),
  "-filter_complex", filter, "-map", "[v]",
  "-c:v", "libwebp_anim", "-lossless", "0", "-quality", String(quality),
  "-compression_level", "4", "-preset", "picture", "-loop", "0", "-an", out,
], { stdio: "inherit" });
if (ff.status !== 0) process.exit(ff.status ?? 1);
console.log(`${out}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MiB, ${length.toFixed(1)} s at ${fps} fps`);
