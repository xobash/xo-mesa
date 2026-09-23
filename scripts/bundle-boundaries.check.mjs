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
  "Overlay-",
  "SearchPanel-",
  "SettingsModal-",
  "SyncModal-",
];
for (const prefix of expectedLazyPrefixes) {
  if (!assetNames.some((name) => name.startsWith(prefix) && name.endsWith(".js"))) {
    throw new Error(`missing lazy production chunk: ${prefix}*.js`);
  }
}

const entry = resolve(dist, entryMatch[1].replace(/^\//, ""));
const visited = new Set();
const staticImports = /(?:^|[;\n])\s*import(?!\s*\()[^;\n]*?["']([^"']+)["']/g;
function visit(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(staticImports)) {
    if (!match[1].startsWith(".")) continue;
    visit(resolve(dirname(file), match[1]));
  }
}
visit(entry);

const forbiddenInitialPrefixes = [
  ...expectedLazyPrefixes,
  "editor-vendor-",
  "terminal-vendor-",
  "pdf-lib-vendor-",
  "pdfjs-vendor-",
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

process.stdout.write(
  `Production bundle boundaries passed (${visited.size} initial module${visited.size === 1 ? "" : "s"}; ${expectedLazyPrefixes.length} lazy surfaces).\n`,
);
