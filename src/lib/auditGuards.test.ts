import { expect, it } from "vitest";
import ts from "typescript";
import pkg from "../../package.json";
import lock from "../../package-lock.json";
import nodeVersion from "../../.node-version?raw";
import dockerfile from "../../Dockerfile?raw";
import readme from "../../README.md?raw";
import terminal from "../../src-tauri/src/terminal.rs?raw";
import agent from "../components/AgentPanel.tsx?raw";
import config from "../../vite.config.ts?raw";

it("removes renderer argv from both sides of terminal launch", () => {
  const signature = terminal.split("pub async fn terminal_start(")[1].split(") ->")[0];
  expect(signature).not.toMatch(/\bargs\s*:/);
  const invoke = agent.split('invoke<string>("terminal_start", {')[1].split("});")[0];
  expect(invoke).not.toMatch(/\bargs\s*:/);
});

it("labels the permissive browser image demo-only at build and entry points", () => {
  expect(dockerfile).toMatch(/demo-only browser preview image/i);
  expect(readme).toMatch(/Docker image is demo-only, not a production deployment/);
});

it("allows patched Node 22 releases while preserving the reviewed toolchain pin", () => {
  expect(pkg.engines.node).toBe(">=22.22.3 <23");
  expect(lock.packages[""].engines.node).toBe(pkg.engines.node);
  expect(nodeVersion.trim()).toBe("22.22.3");
});

it("includes UI components in coverage and excludes their test files", () => {
  expect(config).toContain('"src/components/**/*.tsx"');
  expect(config).toContain('"**/*.test.tsx"');
});

function assertOpaqueFrames(path: string, source: string) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let frames = 0;
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === "dangerouslySetInnerHTML") {
      throw new Error(`${path}: saved-HTML consumers must use sandboxed srcDoc, never inner HTML`);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "innerHTML") {
      throw new Error(`${path}: saved-HTML consumers must not access innerHTML`);
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(tree) === "iframe") {
      frames++;
      const attrs = node.attributes.properties;
      expect(attrs.some(ts.isJsxSpreadAttribute), path).toBe(false);
      const sandbox = attrs.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(tree) === "sandbox");
      expect(sandbox && ts.isJsxAttribute(sandbox) && sandbox.initializer && ts.isStringLiteral(sandbox.initializer) && sandbox.initializer.text === "", path).toBe(true);
      expect(attrs.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === "srcDoc"), path).toBe(true);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(frames, path).toBeGreaterThan(0);
}

it("confines saved-HTML preview consumers to opaque sandboxed srcDoc frames", () => {
  const sources = import.meta.glob<string>("../**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" });
  const consumers: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (/\.test\.tsx?$/.test(path) || path === "./html.ts") continue;
    if (!/\b(stripSavedHtmlPreviewCode|hydrateSavedHtml|savedHtmlFrameDocument)\b/.test(source)) continue;
    consumers.push(path);
    assertOpaqueFrames(path, source);
  }
  expect(consumers.sort()).toEqual(["../components/HtmlView.tsx", "../components/PreviewCard.tsx"]);
});

it("the preview guard rejects a relaxed sandbox, direct source and spread overrides", () => {
  for (const source of ['<iframe srcDoc={html} sandbox="allow-scripts" />', '<iframe src={html} sandbox="" />', '<iframe srcDoc={html} sandbox="" {...props} />', '<><iframe srcDoc={html} sandbox="" /><div dangerouslySetInnerHTML={{__html: html}} /></>']) {
    expect(() => assertOpaqueFrames("fixture.tsx", source)).toThrow();
  }
});
