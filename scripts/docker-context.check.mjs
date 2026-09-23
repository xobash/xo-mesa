#!/usr/bin/env node
import { readFileSync } from "node:fs";

const rules = readFileSync(".dockerignore", "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const expected = [
  "**",
  "!Dockerfile",
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

process.stdout.write(`Docker context allowlist passed (${copiedSources.length} COPY sources).\n`);
