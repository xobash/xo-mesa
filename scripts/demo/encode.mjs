// Turns frames from scripts/demo/record.mjs into the looping README WebP.
// Frames are resampled to a constant rate in page (virtual) time, the end
// crossfades into the opening frame (ffmpeg), and libwebp's img2webp encodes
// it. Output is lossless unless --quality selects lossy VP8, which stores colour
// at quarter resolution and blocks dark gradients and small text.
// Usage: node scripts/demo/encode.mjs [framesDir] [out.webp] [--fps 60] [--effort 0-100] [--quality 0-100]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const fpsArg = flag("fps", null);
const quality = flag("quality", null);
// Lossless effort (img2webp -q); 100 is smallest and slowest.
const effort = flag("effort", 75);
const src = path.resolve(args[0] ?? "tmp/demo-frames");
const out = path.resolve(args[1] ?? "docs/mesa-demo.webp");
const crossfade = 0.7;
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const { frames, slow = 1, fps: captured = 30 } = JSON.parse(fs.readFileSync(path.join(src, "index.json"), "utf8"));
const fps = fpsArg ?? captured;
const t0 = frames[0][1];
const times = frames.map(([, t]) => (t - t0) / slow);
const ticks = Math.floor((times.at(-1) + 0.5) * fps);

// The newest captured frame at or before each output tick.
const seq = [];
for (let k = 0, j = 0; k < ticks; k++) {
  while (j + 1 < times.length && times[j + 1] <= k / fps) j++;
  seq.push(frames[j][0]);
}

// The last ticks fade into the opening frame, so the loop restarts without a cut.
const fade = Math.round(crossfade * fps);
const fadeDir = path.join(src, "crossfade");
fs.rmSync(fadeDir, { recursive: true, force: true });
fs.mkdirSync(fadeDir);
const tail = seq.slice(-fade).flatMap((name) => [`file '${path.join(src, name)}'`, `duration ${(1 / fps).toFixed(6)}`]);
const list = path.join(fadeDir, "list.txt");
fs.writeFileSync(list, [...tail, `file '${path.join(src, seq.at(-1))}'`].join("\n") + "\n");
run("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "warning",
  "-f", "concat", "-safe", "0", "-i", list,
  "-loop", "1", "-i", path.join(src, frames[0][0]),
  "-filter_complex",
  `[0:v]fps=${fps},format=gbrp[a];[1:v]fps=${fps},format=gbrp,trim=duration=${(fade / fps).toFixed(6)}[b];` +
  `[a][b]xfade=transition=fade:duration=${(fade / fps).toFixed(6)}:offset=0,format=rgb24[v]`,
  "-map", "[v]", "-frames:v", String(fade), path.join(fadeDir, "x%03d.png"),
]);
for (let i = 0; i < fade; i++) seq[ticks - fade + i] = path.join("crossfade", `x${String(i + 1).padStart(3, "0")}.png`);

// Repeated ticks become one longer frame; whole-millisecond edges keep 60 fps as 16/17 ms.
const ms = (k) => Math.round((k * 1000) / fps);
const entries = [];
for (let k = 0; k < ticks; ) {
  let e = k + 1;
  while (e < ticks && seq[e] === seq[k]) e++;
  entries.push(["-d", String(ms(e) - ms(k)), seq[k]]);
  k = e;
}

// Segments encode in parallel; each starts with a full key frame, so their
// ANMF chunks concatenate into one valid animation.
const codec = quality === null ? ["-lossless", "-q", String(effort), "-m", "6"] : ["-lossy", "-q", String(quality), "-m", "6"];
const jobs = Math.min(os.availableParallelism(), Math.ceil(entries.length / 50));
const per = Math.ceil(entries.length / jobs);
const segments = await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((done, fail) => {
  const seg = path.join(fadeDir, `seg${i}.webp`);
  const argFile = path.join(fadeDir, `seg${i}.args`);
  const argv = ["-loop", "0", ...codec, ...entries.slice(i * per, (i + 1) * per).flat(), "-o", seg];
  fs.writeFileSync(argFile, argv.join("\n") + "\n");
  const child = spawn("img2webp", [path.relative(src, argFile)], { cwd: src, stdio: ["ignore", "ignore", "inherit"] });
  child.on("exit", (code) => (code === 0 ? done(seg) : fail(new Error(`img2webp segment ${i} exited ${code}`))));
})));

// RIFF chunks: [fourcc, payload]; payloads are padded to even length.
const chunks = (buf) => {
  const list = [];
  for (let o = 12; o < buf.length; ) {
    const size = buf.readUInt32LE(o + 4);
    list.push([buf.toString("ascii", o, o + 4), buf.subarray(o, o + 8 + size + (size & 1))]);
    o += 8 + size + (size & 1);
  }
  return list;
};
const parts = segments.map((seg) => chunks(fs.readFileSync(seg)));
const head = parts[0].filter(([id]) => id === "VP8X" || id === "ANIM").map(([, c]) => Buffer.from(c));
head[0][8] |= parts.reduce((flags, p) => flags | p.find(([id]) => id === "VP8X")[1][8], 0);
const body = parts.flatMap((p) => p.filter(([id]) => id === "ANMF").map(([, c]) => c));
const riff = Buffer.alloc(12);
riff.write("RIFF", 0, "ascii");
riff.writeUInt32LE(4 + [...head, ...body].reduce((n, c) => n + c.length, 0), 4);
riff.write("WEBP", 8, "ascii");
fs.writeFileSync(out, Buffer.concat([riff, ...head, ...body]));
console.log(`${out}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MiB, ${body.length} frames, ${(ticks / fps).toFixed(1)} s at ${fps} fps, ${quality === null ? `lossless effort ${effort}` : `lossy q${quality}`}`);
