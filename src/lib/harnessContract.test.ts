import { describe, expect, it } from "vitest";
// The bundled Pi extension and the native-harness reporter ship compiled into
// the Mesa binary (include_str! in activity.rs / harness.rs). These contract
// tests read those exact sources so a refactor cannot silently break the
// agent-side browse tools, the snapshot transports, or the security gates.
import browserExt from "../../src-tauri/resources/mesa-browser.ts?raw";
import reporter from "../../src-tauri/resources/harness-reporter.js?raw";
import harnessRs from "../../src-tauri/src/harness.rs?raw";
import activityRs from "../../src-tauri/src/activity.rs?raw";
import capabilities from "../../src-tauri/capabilities/default.json";

describe("mesa-browser.ts Pi extension contract", () => {
  it("registers both agent tools", () => {
    expect(browserExt).toContain('name: "browse"');
    expect(browserExt).toContain('name: "browse_read"');
  });

  it("stays inert outside Mesa (env gate before any registration)", () => {
    const gate = browserExt.indexOf("if (!port || !token) return;");
    const register = browserExt.indexOf("pi.registerTool");
    expect(gate).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(gate);
  });

  it("talks only to the loopback server", () => {
    expect(browserExt).toContain("http://127.0.0.1:${port}/browse");
    expect(browserExt).toContain("http://127.0.0.1:${port}/browse/current");
    // No other network destinations.
    const urls = browserExt.match(/https?:\/\/(?!127\.0\.0\.1)[^"'` )]+/g) ?? [];
    expect(urls).toEqual([]);
  });

  it("imports only Pi-runtime modules (never Mesa's npm tree)", () => {
    const imports = [...browserExt.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["typebox"]);
  });

  it("is honest about rendered vs fallback views", () => {
    expect(browserExt).toContain("rendered === true");
    expect(browserExt).toContain("live harness (rendered DOM");
    expect(browserExt).toContain("static fetch fallback");
    // The fallback branch must run htmlToText; the rendered branch must not.
    expect(browserExt).toMatch(/rendered\s*\?\s*\(page\.body \?\? ""\)\.trim\(\)/);
  });
});

describe("harness-reporter.js contract (rendered-DOM snapshots)", () => {
  it("reports only from the top frame", () => {
    expect(reporter).toContain("if (window.top !== window) return;");
  });

  it("stays inert when the template placeholders are unfilled", () => {
    expect(reporter).toContain('PORT.indexOf("__") === 0');
    expect(reporter).toContain("__MESA_PORT__");
    expect(reporter).toContain("__MESA_TOKEN__");
  });

  it("captures pristine fetch before page scripts can wrap it", () => {
    const capture = reporter.indexOf("window.fetch ? window.fetch.bind(window)");
    const firstListener = reporter.indexOf("addEventListener");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(firstListener);
  });

  it("has both transports: loopback fetch and the mesa-snap scheme bridge", () => {
    expect(reporter).toContain('"http://127.0.0.1:" + PORT + "/harness"');
    expect(reporter).toContain('mode: "no-cors"');
    expect(reporter).toContain('"mesa-snap://snap/#" + encodeURIComponent');
  });

  it("exposes the eval-forced report hook Rust relies on", () => {
    expect(reporter).toContain("window.__mesaHarnessReport = function");
    expect(harnessRs).toContain("window.__mesaHarnessReport && window.__mesaHarnessReport()");
  });
});

describe("harness.rs ↔ activity.rs ↔ capabilities security contract", () => {
  it("keeps the harness webview label outside every capability window pattern", () => {
    const label = harnessRs.match(/HARNESS_LABEL: &str = "([^"]+)"/)?.[1];
    expect(label).toBe("pi-harness");
    const patterns = (capabilities as { windows: string[] }).windows;
    for (const pattern of patterns) {
      const re = new RegExp(
        `^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
      );
      expect(re.test(label ?? "")).toBe(false);
    }
  });

  it("intercepts the mesa-snap bridge scheme and confines navigation", () => {
    expect(harnessRs).toContain('"mesa-snap"');
    expect(harnessRs).toContain("return false; // never actually navigate the bridge scheme");
    expect(harnessRs).toMatch(/matches!\(nav_url\.scheme\(\), "http" \| "https" \| "about" \| "blob" \| "data"\)/);
  });

  it("verifies the per-run token on every snapshot ingest", () => {
    expect(harnessRs).toContain("snapshot token mismatch");
    // /harness bypasses header auth (no-cors cannot send headers) but hands
    // the body to the token-checking ingest.
    const harnessRoute = activityRs.indexOf('url == "/harness"');
    const headerAuth = activityRs.indexOf("if !auth_ok(&req, token)");
    expect(harnessRoute).toBeGreaterThan(-1);
    expect(harnessRoute).toBeLessThan(headerAuth);
    expect(activityRs).toContain("ingest_snapshot_body(app, &body, token)");
  });

  it("keeps /browse rendered-first with an honest static fallback", () => {
    expect(activityRs).toContain("bump_nav_gen()");
    expect(activityRs).toContain("wait_for_snapshot(");
    expect(activityRs).toContain('"rendered": true');
    expect(activityRs).toContain("browse_fetch_blocking(target)");
    expect(activityRs).toContain('obj.insert("rendered".into(), serde_json::Value::Bool(false))');
  });

  it("serves the browse_read snapshot route behind header auth", () => {
    const headerAuth = activityRs.indexOf("if !auth_ok(&req, token)");
    const currentRoute = activityRs.indexOf('url == "/browse/current"');
    expect(currentRoute).toBeGreaterThan(headerAuth);
  });
});
