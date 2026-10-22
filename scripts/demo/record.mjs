// Records the README demo (docs/mesa-demo.webp) from the live frontend: drives
// Mesa through the storyboard on a mocked native shell and saves timestamped
// frames. See docs/demo-recording.md. Usage:
//   node scripts/demo/record.mjs [outDir=tmp/demo-frames] [--no-capture] [--shots]
/* global location, localStorage, getComputedStyle, requestAnimationFrame */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startServer } from "./serve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT || 5174);
const BASE = `http://localhost:${PORT}`;
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const OUT = path.resolve(positional[0] ?? "tmp/demo-frames");
const CAPTURE = !process.argv.includes("--no-capture");
const SHOTS = process.argv.includes("--shots");
// Page time runs SLOW x slower than real time so CPU-only Chromium keeps up.
const SLOW = Number(process.env.SLOW || 6);
// Real-time timeouts below are tuned for SLOW=6 and stretch with it.
const T = (ms) => ms * Math.max(1, SLOW / 6);
// Frames are kept per 1/FPS slot of page time; encode.mjs uses the same rate.
const FPS = Number(process.env.FPS || 60);
// An installed Chromium-based browser; never Playwright's Chrome for Testing.
const BROWSER = process.env.DEMO_BROWSER;
if (!BROWSER) throw new Error("Set DEMO_BROWSER to an installed Chromium-based browser executable");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const server = await startServer(PORT);
const browser = await chromium.launch({ executablePath: BROWSER, args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-smooth-scrolling"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", deviceScaleFactor: 1 });
await ctx.addInitScript((k) => { if (window.top === window) window.__REC_K__ = 1 / k; }, SLOW);
await ctx.addInitScript({ path: path.join(here, "timeshim.js") });
await ctx.addInitScript({ path: path.join(here, "mock.js") });
await ctx.addInitScript(() => {
  if (location.pathname.startsWith("/__rec/")) return;
  // 09:41 on the demo day.
  const offset = Date.parse("2026-10-14T09:41:00") - Date.now();
  const Base = Date;
  window.Date = class extends Base {
    constructor(...a) { if (a.length === 0) super(Base.now() + offset); else super(...a); }
    static now() { return Base.now() + offset; }
  };
  try {
    if (!localStorage.getItem("rec:init")) {
      localStorage.setItem("rec:init", "1");
      localStorage.setItem("mesa:toured", "1");
      localStorage.setItem("mesa:overlayToured", "1");
      localStorage.setItem("mesa:theme", "midnight");
      localStorage.setItem("mesa:uiStyle", "studio");
    }
  } catch { /* storage unavailable */ }
});
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()} ${m.text()}`));
page.on("pageerror", (e) => logs.push(`PAGEERR ${e.message}`));
await page.goto(`${BASE}/__rec/index.html`);
await page.evaluate(() => { document.getElementById("app").src = "/"; });
let app = null;
for (let i = 0; i < 300 && !app; i++) {
  app = page.frames().find((f) => f.name() === "main" && f.url().startsWith(BASE)) ?? null;
  if (!app) await page.waitForTimeout(50);
}
if (!app) throw new Error("Mesa frame did not load");
const S = (fn, ...args) => page.evaluate(fn, ...args);
const wait = (ms) => page.waitForTimeout(Math.max(1, ms * SLOW));
let cursor = { x: 1150, y: 780 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function moveTo(x, y, ms) {
  const from = { ...cursor };
  const dist = Math.hypot(x - from.x, y - from.y);
  const dur = (ms ?? Math.min(950, 300 + dist * 0.45)) * SLOW;
  // A gentle arc reads as a human hand rather than a ruler.
  const bow = Math.min(60, dist * 0.08) * (x > from.x ? -1 : 1);
  const t0 = Date.now();
  for (;;) {
    const u = Math.min(1, (Date.now() - t0) / dur);
    const t = ease(u);
    const px = from.x + (x - from.x) * t;
    const py = from.y + (y - from.y) * t + Math.sin(Math.PI * t) * bow;
    await page.mouse.move(px, py);
    await S(([a, b]) => window.__REC_SHARED__.setCursor(a, b), [px, py]);
    if (u >= 1) break;
    await page.waitForTimeout(25);
  }
  cursor = { x, y };
}
// Wheel input spread over every page frame with easing. Separate wheel ticks
// land as single-frame jumps; the browser's own smooth scrolling runs in real
// time, which is SLOW x too fast in page time, so it is turned off at launch.
async function wheel(dy, ms) {
  // Paced by the clock like moveTo, so a slow round trip never skips a frame.
  const dur = ms * SLOW, t0 = Date.now();
  let sent = 0;
  for (;;) {
    const u = Math.min(1, (Date.now() - t0) / dur);
    const want = Math.round(dy * ease(u));
    if (want !== sent) { await page.mouse.wheel(0, want - sent); sent = want; }
    if (u >= 1) break;
    await page.waitForTimeout(25);
  }
}
async function smoothInto(loc, block) {
  await loc.evaluate((el, block) => new Promise((done) => {
    let sc = el.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (!sc) return done();
    const er = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    const delta = block === "start" ? er.top - sr.top - 8 : er.bottom - sr.bottom + 12;
    const from = sc.scrollTop, to = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, from + delta));
    const t0 = performance.now(), dur = 700;
    const step = () => { const t = Math.min(1, (performance.now() - t0) / dur); const e = t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2; sc.scrollTop = from + (to - from) * e; if (t < 1) requestAnimationFrame(step); else done(); };
    requestAnimationFrame(step);
  }), block);
}
const center = async (loc) => {
  await loc.waitFor({ state: "visible", timeout: T(20000) });
  const b = await loc.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
async function click(loc, { hold = 220, dx = 0, dy = 0 } = {}) {
  const [x, y] = await center(loc);
  await moveTo(x + dx, y + dy);
  await wait(hold);
  await page.mouse.down(); await wait(70); await page.mouse.up();
}
async function dragTo(fromLoc, x, y, { dur = 900, offset = [0, 0] } = {}) {
  const [fx, fy] = await center(fromLoc);
  await moveTo(fx + offset[0], fy + offset[1]);
  await wait(200);
  await page.mouse.down();
  await wait(120);
  await moveTo(x, y, dur);
  await wait(160);
  await page.mouse.up();
}
async function type(text, { min = 45, max = 95 } = {}) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await wait(min + Math.random() * (max - min) + (ch === " " ? 30 : 0));
  }
}
async function keys(labels, combo, after = 650) {
  await S((l) => window.__REC_SHARED__.keys(l), labels);
  await wait(260);
  await page.keyboard.press(combo);
  await wait(after);
  await S(() => window.__REC_SHARED__.clearKeys());
}
const caption = (n, head, sub) => S(([a, b, c]) => window.__REC_SHARED__.caption(a, b, c), [n, head, sub]);
let shot = 0;
const snap = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(OUT, `shot-${String(++shot).padStart(2, "0")}-${name}.png`) }); };

// Theme wipe: diagonal sweep using the View Transitions API inside the app frame.
async function wipeTheme(theme, ms = 1100) {
  await app.evaluate(async ([t, dur]) => {
    const { useAppStore } = await import("/src/store.ts");
    if (!document.getElementById("rec-wipe")) {
      const st = document.createElement("style"); st.id = "rec-wipe";
      st.textContent = `::view-transition-old(root){animation:none}
        ::view-transition-new(root){animation:rec-wipe var(--rec-dur) cubic-bezier(.65,0,.25,1) both}
        @keyframes rec-wipe{from{clip-path:polygon(115% 0,145% 0,125% 100%,95% 100%)}to{clip-path:polygon(-40% 0,145% 0,125% 100%,-60% 100%)}}`;
      document.head.appendChild(st);
    }
    document.documentElement.style.setProperty("--rec-dur", `${dur}ms`);
    const vt = document.startViewTransition(async () => {
      useAppStore.getState().setTheme(t);
      // Let React commit the theme. Rendering is held during this callback,
      // so waiting on animation frames here can stall until the browser aborts.
      await new Promise((r) => setTimeout(r, 120));
    });
    await vt.ready;
    // View transitions run on the browser's real clock, so under SLOW the wipe
    // would finish in a few frames. Pause it and step it in page time instead.
    const anims = document.getAnimations().filter((a) => a.effect?.pseudoElement?.startsWith("::view-transition"));
    anims.forEach((a) => a.pause());
    const t0 = performance.now();
    await new Promise((done) => {
      const step = () => {
        const el = Math.min(dur, performance.now() - t0);
        anims.forEach((a) => { a.currentTime = el; });
        if (el < dur) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
    anims.forEach((a) => a.finish());
    await vt.finished;
  }, [theme, ms]);
}

// --- capture -------------------------------------------------------------------
const cdp = await page.context().newCDPSession(page);
let frames = 0;
let t0 = null;
const index = [];
// Lossless frames; a newer frame in the same page-time slot replaces the older one.
cdp.on("Page.screencastFrame", async (f) => {
  frames++;
  t0 ??= f.metadata.timestamp;
  const slot = Math.floor(((f.metadata.timestamp - t0) / SLOW) * FPS);
  const name = `f${String(slot).padStart(5, "0")}.png`;
  fs.writeFileSync(path.join(OUT, name), Buffer.from(f.data, "base64"));
  if (index.at(-1)?.[0] === name) index.at(-1)[1] = f.metadata.timestamp;
  else index.push([name, f.metadata.timestamp]);
  try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch { /* capture stopped */ }
});
await cdp.send("Animation.enable");
await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / SLOW });
async function startCapture() { if (CAPTURE) await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1920, maxHeight: 1080 }); }
async function stopCapture() { if (CAPTURE) await cdp.send("Page.stopScreencast"); }
const marks = [];
const mark = (label) => marks.push([label, Date.now() / 1000]);

// --- setup (not recorded) ------------------------------------------------------------
await app.locator(".tree-file").filter({ hasText: /^2026-10-14$/ }).first().waitFor({ timeout: T(30000) });
await wait(1200);
await app.locator(".tree-file").filter({ hasText: /^2026-10-14$/ }).first().click();
await wait(600);
await page.mouse.move(cursor.x, cursor.y);
await S(([x, y]) => window.__REC_SHARED__.setCursor(x, y, "text"), [cursor.x, cursor.y]);
await app.evaluate(async () => { const { useAppStore } = await import("/src/store.ts"); window.__STORE__ = useAppStore; });
await wait(1500);

await startCapture();
mark("start");

// --- 00: the workspace, in every theme ---------------------------------------------
await wait(1700);
await wipeTheme("paper"); await wait(1300);
await snap("paper");
await wipeTheme("dusk"); await wait(900);
await wipeTheme("graphite"); await wait(900);
await wipeTheme("midnight"); await wait(700);

// --- 01: plan the day ------------------------------------------------------------------
mark("01");
await caption("01", "Plan the day", "Shift+Tab opens Calendar and Pi over your notes");
await moveTo(1000, 640);
await keys(["⇧ Shift", "⇥ Tab"], "Shift+Tab", 900);
await snap("overlay");
await click(app.locator('[data-calendar-date="2026-10-16"] .cal2-ban').first());
await wait(900);
await click(app.locator('[data-calendar-date="2026-10-20"] .cal2-ban').first());
await wait(1000);
await click(app.locator(".ov-dock button").filter({ hasText: "Pi" }).first());
await wait(1300);
await moveTo(600, 560);
await type("What's left for today?");
await wait(300);
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__REC_SHARED__.pi.current?.status?.[1] === "● ready" && window.__REC_SHARED__.pi.current.lines.length > 8, null, { timeout: T(30000), polling: 200 });
await snap("pi-answer");
await wait(1800);

// --- 02: research the gap -----------------------------------------------------------------
mark("02");
await caption("02", "Research the gap", "Pi reads sources in Mesa's browser · you review every change");
await click(app.getByRole("button", { name: "Place Pi in workspace" }));
await wait(1300);
await dragTo(app.locator(".pi-terminal-heading").first(), 760, 520, { dur: 1000, offset: [-120, 0] });
await wait(1100);
await snap("pi-center");
await click(app.getByRole("button", { name: "Open browser harness" }));
await wait(800);
const urlBox = app.locator(".agent-browser-wing input").first();
await click(urlBox);
await type("urchin barrens recovery");
await wait(250);
await page.keyboard.press("Enter");
await wait(1500);
const reader = app.frameLocator(".agent-browser-wing iframe").first();
await click(reader.getByText("Kelp forest — overview").first());
await wait(1800);
await snap("article");
await wheel(280, 500);
await wait(700);
await click(app.getByRole("button", { name: "Open Deep Research" }));
await wait(900);
await click(app.getByPlaceholder(/What should Pi research/));
await type("How fast do kelp forests recover after marine heatwaves?", { min: 35, max: 70 });
await wait(400);
await S(() => { window.__REC_SHARED__.research.pace = 0.6; });
await click(app.getByRole("button", { name: /Start research/ }));
await page.waitForFunction(() => !!window.__REC_SHARED__.research.lastReply, null, { timeout: T(90000), polling: 250 });
await wait(1200);
await snap("research-done");
const apply = app.getByRole("button", { name: /Apply 3 changes/ });
const panel = app.locator(".dr-wing").first();
const pb = await panel.boundingBox();
await moveTo(pb.x + pb.width / 2, pb.y + pb.height * 0.35);
await wait(300);
await smoothInto(app.locator(".dr-review").first(), "start");
await wait(1100);
await click(app.locator(".dr-op").first());
await wait(1600);
await smoothInto(apply, "end");
await wait(900);
await click(apply);
await wait(1500);
await snap("applied");
await click(app.locator(".dr-wing, .deep-research").getByText("Research/Kelp recovery after marine heatwaves.md").first());
await wait(1600);
await click(app.getByRole("button", { name: "Close Pi agent" }).first());
await wait(900);

// --- 03: watch the graph grow ------------------------------------------------------------
mark("03");
await caption("03", "Watch the graph grow", "New notes arrive linked to what you already know");
await click(app.getByRole("button", { name: "Expand graph" }));
await wait(1400);
const gpos = async (id) => {
  const p = await app.evaluate((i) => window.__REC_GRAPH__?.pos(i), id);
  const fb = await page.locator("#app").boundingBox();
  return p ? [fb.x + p.x, fb.y + p.y] : null;
};
{
  const r = await gpos("Research/Kelp recovery after marine heatwaves.md");
  await moveTo(r[0], r[1], 900);
  await wheel(-990, 1000);
  await wait(1800);
}
const hoverNode = async (id, hold) => {
  let p = await gpos(id); if (!p) { console.log("missing node", id); return; }
  await moveTo(p[0], p[1]);
  p = await gpos(id); await moveTo(p[0], p[1], 120);
  await wait(hold);
};
await hoverNode("Research/Kelp recovery after marine heatwaves.md", 1200);
await hoverNode("Research/Kelp recovery windows.md", 2000);
await snap("hover");
await hoverNode("Topics/Kelp Forests.md", 700);
await hoverNode("Projects/Chapter 3 - Canopy Recovery.md", 700);
await page.mouse.down(); await wait(80); await page.mouse.up();
await page.waitForSelector(".popout", { timeout: T(15000) });
await wait(1400);
await snap("popout");
await click(app.getByRole("button", { name: "Exit full graph" }));
await wait(900);
const bar = page.locator(".popout .titlebar").first();
const bb = await bar.boundingBox();
await moveTo(bb.x + bb.width / 2 + 60, bb.y + 14);
await wait(250);
await page.mouse.down(); await wait(100);
await moveTo(bb.x + bb.width / 2 + 380, bb.y + 120, 900);
await wait(300);
await moveTo(820, 400, 1000);
await wait(500);
await page.mouse.up();
await wait(1600);
await snap("docked");

// --- 04: find it again ----------------------------------------------------------------------
mark("04");
await caption("04", "Find it again", "Search everything · arrow keys preview each match");
await moveTo(1500, 760);
await app.locator("body").focus().catch(() => {});
await app.evaluate(() => { document.activeElement?.blur?.(); window.focus(); });
await keys(["/"], "/", 700);
await type("recovery", { min: 70, max: 120 });
await wait(900);
for (let i = 0; i < 3; i++) { await keys(["↓"], "ArrowDown", 700); }
await wait(500);
await keys(["↩ Enter"], "Enter", 900);
await wait(1800);
await snap("found");
await caption("", "", "");
const tree = app.locator(".sidebar").first();
const tb = await tree.boundingBox();
await moveTo(tb.x + tb.width / 2, tb.y + tb.height / 2);
await wheel(-3840, 1000);
await wait(500);
await click(app.locator(".tree-file").filter({ hasText: /^2026-10-14$/ }).first());
await wait(1800);
mark("end");
await stopCapture();
await wait(300);

fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ frames: index, marks, slow: SLOW, fps: FPS }, null, 1));
console.log(`frames ${frames} captured, ${index.length} slots kept  span ${(index.at(-1)?.[1] - index[0]?.[1]).toFixed(1)}s`);
console.log(logs.filter((l) => /error|PAGEERR/i.test(l)).slice(0, 20).join("\n"));
await browser.close();
await server.close();
