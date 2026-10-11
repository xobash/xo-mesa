#!/usr/bin/env node
import { readFileSync } from "node:fs";

const rules = readFileSync(".dockerignore", "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const expected = [
  "**",
  "!Dockerfile",
  "!nginx.conf",
  "!.dockerignore",
  "!package.json",
  "!package-lock.json",
  "!index.html",
  "!vite.config.ts",
  "!tsconfig.json",
  "!tsconfig.node.json",
  "!src/",
  "!src/**",
  "!public/",
  "!public/**",
  "!scripts/",
  "!scripts/third-party-notices.mjs",
  "!scripts/docker-context.check.mjs",
  "!scripts/bundle-boundaries.check.mjs",
  "!src-tauri/",
  "!src-tauri/Cargo.lock",
  "!src-tauri/tauri.conf.json",
  "**/*.local.*",
];
if (JSON.stringify(rules) !== JSON.stringify(expected)) {
  throw new Error("Docker context must remain an explicit browser-build allowlist");
}

const dockerfile = readFileSync("Dockerfile", "utf8");
const copiedSources = [...dockerfile.matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)]
  .filter((match) => !match[1].trim().startsWith("--from="))
  .flatMap((match) => match[1].trim().split(/\s+/));
const allowedFiles = new Set(expected.filter((rule) => rule.startsWith("!")).map((rule) => rule.slice(1)));
for (const source of copiedSources) {
  const allowed =
    allowedFiles.has(source) ||
    [...allowedFiles].some((rule) => rule.endsWith("/**") && source.startsWith(rule.slice(0, -3)));
  if (!allowed) throw new Error(`Dockerfile COPY source is absent from context: ${source}`);
}

const nativeCsp = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.security.csp;
const nginx = readFileSync("nginx.conf", "utf8");
const demoCsp = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
if (!demoCsp) throw new Error("Demo CSP header missing");
const directives = policy => new Map(policy.split(";").map(d => {
  const [name, ...sources] = d.trim().split(/\s+/);
  return [name, sources];
}));
const nativePolicy = directives(nativeCsp), demoPolicy = directives(demoCsp);
const nativeOnly = new Set(["asset:", "tauri:", "ipc:", "http://asset.localhost", "https://asset.localhost", "http://ipc.localhost", "https://ipc.localhost"]);
if (nativePolicy.size !== demoPolicy.size) throw new Error("Demo CSP directives differ from native policy");
for (const [name, sources] of nativePolicy) {
  const expectedSources = sources.filter(source => !nativeOnly.has(source)).sort();
  if (JSON.stringify(expectedSources) !== JSON.stringify(demoPolicy.get(name)?.sort())) {
    throw new Error(`Demo CSP differs from native policy: ${name}`);
  }
}

process.stdout.write(`Docker context allowlist passed (${copiedSources.length} COPY sources).\n`);
