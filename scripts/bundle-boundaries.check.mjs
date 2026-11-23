#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const dist = resolve("dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
if (!entryMatch) throw new Error("production HTML has no module entry");

const assets = join(dist, "assets");
const assetNames = readdirSync(assets);
const expectedLazyPrefixes = [
  "AgentPanel-",
  "CommandPalette-",
  "ConnectVaultModal-",
  "Editor-",
  "GraphView-",
  "HtmlView-",
  "LegacyOfficeView-",
  "markdownMath-",
  "markdownMermaid-",
  "OpenDocumentView-",
  "Overlay-",
  "SearchPanel-",
  "SettingsModal-",
  "SpreadsheetView-",
  "SyncModal-",
  "wordEngine-",
  "WordView-",
];
for (const prefix of expectedLazyPrefixes) {
  if (!assetNames.some((name) => name.startsWith(prefix) && name.endsWith(".js"))) {
    throw new Error(`missing lazy production chunk: ${prefix}*.js`);
  }
}

const entry = resolve(dist, entryMatch[1].replace(/^\//, ""));
const visited = new Set();
const staticImports = /(?:^|[;\n])\s*import(?!\s*\()[^;\n]*?["']([^"']+)["']/g;
// Explicit stack, no recursion: chunk chains are build-sized. Children are
// pushed in reverse so the walk keeps depth-first source order.
const pending = [entry];
while (pending.length) {
  const file = pending.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  const imports = [...source.matchAll(staticImports)].map((match) => match[1]).filter((path) => path.startsWith("."));
  for (let index = imports.length - 1; index >= 0; index -= 1) pending.push(resolve(dirname(file), imports[index]));
}

const forbiddenInitialPrefixes = [
  ...expectedLazyPrefixes,
  "editor-core-vendor-",
  "editor-language-vendor-",
  "terminal-vendor-",
  "pdf-lib-vendor-",
  "pdfjs-vendor-",
  "katex-vendor-",
];
const violations = [...visited]
  .map((file) => basename(file))
  .filter((name) => forbiddenInitialPrefixes.some((prefix) => name.startsWith(prefix)));
if (violations.length) {
  throw new Error(`lazy code became statically reachable from the entry: ${violations.join(", ")}`);
}

for (const href of html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g)) {
  const name = basename(href[1]);
  if (forbiddenInitialPrefixes.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`lazy code was preloaded by production HTML: ${name}`);
  }
}

// The webview floor reads woff2; legacy font formats are dead weight.
const katexFonts = assetNames.filter((name) => name.startsWith("KaTeX_"));
const legacyFonts = katexFonts.filter((name) => !name.endsWith(".woff2"));
if (legacyFonts.length) {
  throw new Error(`legacy KaTeX font formats shipped: ${legacyFonts.slice(0, 3).join(", ")}`);
}
if (!katexFonts.length) throw new Error("KaTeX woff2 fonts are missing from the production bundle");

process.stdout.write(
  `Production bundle boundaries passed (${visited.size} initial module${visited.size === 1 ? "" : "s"}; ${expectedLazyPrefixes.length} lazy surfaces).\n`,
);
