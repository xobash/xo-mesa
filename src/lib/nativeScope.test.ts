import { describe, expect, it } from "vitest";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

const capabilities = Object.values(import.meta.glob<{ windows?: string[]; permissions?: Array<string | { identifier: string }> }>(
  "../../src-tauri/capabilities/*.json", { eager: true, import: "default" },
));

function matchesWindow(pattern: string, label: string): boolean {
  return pattern === label || (pattern.endsWith("*") && label.startsWith(pattern.slice(0, -1)));
}

describe("native filesystem and remote-browser scopes", () => {
  it("starts filesystem and asset access empty", () => {
    const fsScope = defaultCapability.permissions.find(
      (permission) => typeof permission === "object" && permission.identifier === "fs:scope",
    );
    expect(fsScope).toEqual({ identifier: "fs:scope", allow: [] });
    expect(tauriConfig.app.security.assetProtocol).toEqual({ enable: true, scope: [] });
    expect(tauriConfig.plugins.fs.requireLiteralLeadingDot).toBe(true);
  });

  it("grants no Tauri capability to remote page webviews", () => {
    for (const label of ["pi-harness", "pi-ext-browser-1", "pi-ext-browser-test"]) {
      expect(capabilities.some((capability) => capability.windows?.some((pattern) => matchesWindow(pattern, label)))).toBe(false);
    }
  });
});

describe("main workspace authority", () => {
  const grants = (label: string) => capabilities.filter(c => c.windows?.some(p => matchesWindow(p, label))).flatMap(c => c.permissions ?? []).filter(p => typeof p === "string");
  it("keeps destructive file, credential and sync operations out of document/panel windows", () => {
    for (const permission of ["allow-vault-move-to-recovery", "allow-vault-restore-recovery", "allow-sync-run", "allow-sync-start", "allow-sync-secrets-read", "allow-vault-apply-research"]) {
      expect(grants("main")).toContain(permission);
      for (const label of ["doc-1", "panel-graph", "panel-preview"]) expect(grants(label)).not.toContain(permission);
    }
  });
});

describe("privileged application script policy", () => {
  it("permits no arbitrary inline script or remote script source", () => {
    const policy = tauriConfig.app.security.csp.split(';').find(d => d.trim().startsWith('script-src'))!;
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain('https:');
    expect(policy).toContain("'sha256-");
  });
});

it("denies every generic mutation and file-open route in every app window", () => {
  for (const capability of capabilities) for (const permission of capability.permissions ?? []) {
    const identifier = typeof permission === "string" ? permission : permission.identifier;
    expect(identifier).not.toMatch(/^fs:(default|allow-(write.*|mkdir|remove|rename|copy-file|open|create|truncate))$/);
  }
});

it("keeps arbitrary HTTPS connections out of the privileged renderer", () => {
  const policy=tauriConfig.app.security.csp.split(';').find(d=>d.trim().startsWith('connect-src'))!;
  expect(policy).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
});

it("does not let secondary windows mint privileged window labels or bridge authority", () => {
  const grants = (label: string) => capabilities.filter(c => c.windows?.some(p => matchesWindow(p, label))).flatMap(c => c.permissions ?? []);
  for (const permission of ["core:webview:allow-create-webview-window", "allow-activity-start", "allow-activity-stop", "allow-activity-set-context", "allow-sync-cancel"]) {
    expect(grants("main")).toContain(permission);
    for (const label of ["doc-one", "panel-one", "agent-one"]) expect(grants(label)).not.toContain(permission);
  }
  for (const label of ["doc-one", "panel-one"]) expect(grants(label)).not.toContain("allow-browse-fetch");
  expect(grants("agent-one")).toContain("allow-browse-fetch");
});
