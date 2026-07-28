import { describe, expect, it } from "vitest";
// The bundled Pi extension and the native-harness reporter ship compiled into
// the Mesa binary (include_str! in activity.rs / harness.rs). These contract
// tests read those exact sources so a refactor cannot silently break the
// agent-side browse tools, the snapshot transports, or the security gates.
import activityExt from "../../src-tauri/resources/mesa-activity.ts?raw";
import browserExt from "../../src-tauri/resources/mesa-browser.ts?raw";
import contextExt from "../../src-tauri/resources/mesa-context.ts?raw";
import deepResearchExt from "../../src-tauri/resources/mesa-deep-research.ts?raw";
import reporter from "../../src-tauri/resources/harness-reporter.js?raw";
import harnessRs from "../../src-tauri/src/harness.rs?raw";
import activityRs from "../../src-tauri/src/activity.rs?raw";
import capabilities from "../../src-tauri/capabilities/default.json";
import agentSrc from "./agent.ts?raw";
import { PI_BLOCKED_BINARY_EXTENSIONS, piBinaryWriteBlock } from "./agent";

describe("mesa-context.ts live workspace contract", () => {
  it("injects authenticated loopback context before every agent turn", () => {
    expect(contextExt).toContain('pi.on("before_agent_start"');
    expect(contextExt).toContain("async (event)");
    expect(contextExt).toContain("http://127.0.0.1:${port}/context");
    expect(contextExt).toContain("Authorization: `Bearer ${token}`");
    expect(contextExt).toContain("event.systemPrompt +");
    expect(contextExt).toContain("supersedes any older Mesa workspace context");
  });

  it("stays inert outside Mesa and has no non-loopback destination", () => {
    const gate = contextExt.indexOf("if (!port || !token) return;");
    const hook = contextExt.indexOf('pi.on("before_agent_start"');
    expect(gate).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(gate);
    const urls = contextExt.match(/https?:\/\/(?!127\.0\.0\.1)[^"'` )]+/g) ?? [];
    expect(urls).toEqual([]);
  });

  it("is materialized and served behind the activity auth gate", () => {
    expect(activityRs).toContain("CONTEXT_EXTENSION_SRC");
    expect(activityRs).toContain("context_extension_path");
    const headerAuth = activityRs.indexOf("if !auth_ok(&req, token)");
    const contextRoute = activityRs.indexOf('url == "/context"');
    expect(contextRoute).toBeGreaterThan(headerAuth);
    expect(activityRs).toContain("activity_set_context");
  });
});

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
    expect(harnessRs).toMatch(
      /matches!\(\s*nav_url\.scheme\(\),\s*"http" \| "https" \| "about" \| "blob" \| "data"\s*\)/,
    );
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

describe("mesa-deep-research.ts Pi extension contract", () => {
  it("registers both Deep Research tools", () => {
    expect(deepResearchExt).toContain('name: "deep_research_progress"');
    expect(deepResearchExt).toContain('name: "deep_research_finish"');
  });

  it("stays inert outside Mesa (env gate before any registration)", () => {
    const gate = deepResearchExt.indexOf("if (!port || !token) return;");
    const register = deepResearchExt.indexOf("pi.registerTool");
    expect(gate).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(gate);
  });

  it("talks only to the loopback deep-research route", () => {
    expect(deepResearchExt).toContain("http://127.0.0.1:${port}/deep-research");
    const urls = deepResearchExt.match(/https?:\/\/(?!127\.0\.0\.1)[^"'` )]+/g) ?? [];
    expect(urls).toEqual([]);
  });

  it("imports only Pi-runtime modules (never Mesa's npm tree)", () => {
    const imports = [...deepResearchExt.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["typebox"]);
  });

  it("blocks Pi's mutation-capable tools only while a run is active (fail-safe read-only)", () => {
    expect(deepResearchExt).toContain('process.env.MESA_DEEP_RESEARCH === "1"');
    expect(deepResearchExt).toContain('pi.on("tool_call"');
    expect(deepResearchExt).toContain("block: true");
    expect(deepResearchExt).toContain('["write", "edit", "apply_patch", "bash", "shell", "exec"]');
    // The block must be gated on `active` so a normal session is unaffected.
    expect(deepResearchExt).toMatch(/if \(!active\) return undefined;/);
  });

  it("carries rounds and live report snapshots through the progress tool", () => {
    expect(deepResearchExt).toContain("round: Type.Optional(Type.Number");
    expect(deepResearchExt).toContain("draftMarkdown: Type.Optional(Type.String");
    expect(deepResearchExt).toContain("draftMarkdown: params?.draftMarkdown");
  });

  it("is wired into the Rust loopback server (route + emit + extension path)", () => {
    expect(activityRs).toContain('url == "/deep-research"');
    expect(activityRs).toContain('app.emit("mesa://deep-research", body)');
    expect(activityRs).toContain("deep_research_extension_path");
    expect(activityRs).toContain("DEEP_RESEARCH_EXTENSION_SRC");
  });
});

describe("mesa-activity.ts binary-write block contract", () => {
  // This extension is the only thing standing between Pi's text-oriented write
  // tools and the user's binary files. It is compiled into the Rust binary via
  // include_str! and cannot import src/lib, so it hand-mirrors the tested
  // reference in agent.ts. These tests are what keep the two copies honest.

  /** The extension's inline mirror of PI_BLOCKED_BINARY_EXTENSIONS. */
  function extensionListFromSource(): string[] {
    const m = /const BLOCKED_BINARY_EXTENSIONS = \[([\s\S]*?)\];/.exec(activityExt);
    if (!m) throw new Error("BLOCKED_BINARY_EXTENSIONS not found in mesa-activity.ts");
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }

  it("mirrors the tested extension list in agent.ts exactly", () => {
    expect(extensionListFromSource()).toEqual([...PI_BLOCKED_BINARY_EXTENSIONS]);
  });

  it("mirrors the tested content-write tool list", () => {
    expect(activityExt).toContain(
      'const CONTENT_WRITE_TOOLS = ["write", "edit", "apply_patch"];'
    );
  });

  it("mirrors the reason string the model is given", () => {
    // A drifting reason is a silent behaviour change: it is the only feedback
    // the agent gets, and a vague one makes it retry the corrupting write.
    const reasonTemplate = (source: string): string => {
      const m = /reason:\s*(`Mesa blocked this write[\s\S]*?),\s*\};/.exec(source);
      if (!m) throw new Error("block reason template not found");
      return m[1].replace(/\s+/g, " ").trim();
    };
    expect(reasonTemplate(activityExt)).toBe(reasonTemplate(agentSrc));
    // And it actually says the two things that stop a retry loop.
    const reason = piBinaryWriteBlock("write", "/vault/a.pdf")!.reason;
    expect(reason).toContain("Do not retry with different content.");
    expect(reason).toContain("bash");
  });

  it("actually blocks — returns the block payload from the tool_call hook", () => {
    expect(activityExt).toContain("block: true");
    expect(activityExt).toContain("const blocked = binaryWriteBlock(toolName, absPath);");
    expect(activityExt).toContain("if (blocked) return blocked;");
  });

  it("decides the block before reporting, so a blocked write is not graph activity", () => {
    const blockIdx = activityExt.indexOf("if (blocked) return blocked;");
    const reportIdx = activityExt.indexOf("if (op) report(op, absPath);");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(reportIdx).toBeGreaterThan(blockIdx);
  });

  it("stays inert outside Mesa (env gate before the hook is registered)", () => {
    const gate = activityExt.indexOf("if (!port || !token) return;");
    const hook = activityExt.indexOf('pi.on("tool_call"');
    expect(gate).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(gate);
  });

  it("never blocks bash, so an agent can still drive real binary tools", () => {
    expect(extensionListFromSource()).not.toContain("bash");
    expect(activityExt).not.toMatch(/CONTENT_WRITE_TOOLS[^;]*bash/);
  });

  it("talks only to the loopback server", () => {
    const urls = activityExt.match(/https?:\/\/(?!127\.0\.0\.1)[^"'` )]+/g) ?? [];
    expect(urls).toEqual([]);
  });

  it("no longer carries the removed snapshot machinery", () => {
    // The .mesa-pi-snapshot-*.bak safety net was removed in favour of the
    // block above; leftover copy code would silently resurrect it.
    expect(activityExt).not.toContain("copyFileSync");
    expect(activityExt).not.toContain("mesa-pi-snapshot");
  });
});
