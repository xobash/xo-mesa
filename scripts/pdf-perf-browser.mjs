#!/usr/bin/env node
import { createRequire } from "node:module";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = createRequire(import.meta.url)("playwright"));
  } catch {
    console.error(
      "Playwright is required for this measurement script. Install it locally or run from an environment where the `playwright` package is available."
    );
    process.exit(2);
  }
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const url = arg("url", "http://127.0.0.1:1420/");
const file = arg("file", "Mesa PDF Tour.pdf");
const runs = Math.max(1, Number(arg("runs", "3")) || 3);
const mainThreadBlockMs = Math.max(0, Number(arg("main-thread-block-ms", "0")) || 0);

function summarize(run) {
  const eventAt = (name) => run.events.find((event) => event.name === name)?.at ?? null;
  return {
    relPath: run.file.relPath,
    size: run.file.size ?? null,
    events: run.events,
    metrics: {
      bytesReadMs: delta(run, "bytes-read-start", "bytes-read-end"),
      parseMs: delta(run, "pdfjs-parse-start", "pdfjs-parse-end"),
      page1RasterMs: delta(run, "page-1-render-start", "page-1-raster-end"),
      timeToFirstMeaningfulPageMs: eventAt("first-meaningful-page"),
      windowPaintedMs: eventAt("window-painted"),
      pageMeasureEndMs: eventAt("page-measure-end"),
      nativeIframeLoadedMs: eventAt("native-iframe-loaded"),
    },
    // Counts, not clocks: these are the numbers that expose wasted work
    // regardless of how the host throttles timers.
    counters: run.counters ?? {},
  };
}

function delta(run, start, end) {
  const a = run.events.find((event) => event.name === start)?.at;
  const b = run.events.find((event) => event.name === end)?.at;
  return typeof a === "number" && typeof b === "number" ? b - a : null;
}

function cssString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function selectPdf(page) {
  await page.waitForSelector(".file-tree", { timeout: 10000 });
  const escaped = cssString(file);
  const row = page.locator(`button.tree-file[data-rel="${escaped}"]`);
  await row.waitFor({ timeout: 10000 });
  await row.click();
}

async function waitForPdfRun(page) {
  await page.waitForFunction(() => {
    const state = window.__MESA_PDF_PERF__;
    const run = state?.runs?.[state.runs.length - 1];
    return !!run?.events?.some((event) => event.name === "window-painted");
  }, null, { timeout: 15000 });
  await page.waitForTimeout(100);
  return page.evaluate(() => {
    const state = window.__MESA_PDF_PERF__;
    return state?.runs?.[state.runs.length - 1] ?? null;
  });
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      pageErrors.push(String(error?.message ?? error));
    });
    await page.addInitScript((blockMs) => {
      window.__MESA_LONG_TASKS__ = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__MESA_LONG_TASKS__.push({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {
        window.__MESA_LONG_TASKS_UNAVAILABLE__ = true;
      }
      if (blockMs > 0) {
        window.__MESA_BLOCK_MAIN_THREAD__ = () => {
          const until = performance.now() + blockMs;
          while (performance.now() < until) {
            Math.sqrt(Math.random());
          }
        };
      }
    }, mainThreadBlockMs);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (mainThreadBlockMs > 0) {
      await page.evaluate(() => window.__MESA_BLOCK_MAIN_THREAD__?.());
    }
    await selectPdf(page);
    const run = await waitForPdfRun(page);
    const browserStats = await page.evaluate(() => ({
      longTasks: window.__MESA_LONG_TASKS__ ?? [],
      memory: performance.memory
        ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
          }
        : null,
      canvasCount: document.querySelectorAll('[data-testid="pdf-page-canvas"]').length,
      firstCanvasSize:
        (() => {
          const canvas = document.querySelector('[data-testid="pdf-page-canvas"]');
          return canvas ? { width: canvas.width, height: canvas.height } : null;
        })(),
    }));
    results.push({
      run: run ? summarize(run) : null,
      browser: browserStats,
      consoleErrors,
      pageErrors,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ url, file, runs, mainThreadBlockMs, results }, null, 2));
