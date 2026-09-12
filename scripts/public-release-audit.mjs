#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (git.status !== 0) {
  process.stderr.write(git.stderr || "git ls-files failed\n");
  process.exit(git.status || 1);
}

const tracked = git.stdout.split("\0").filter(Boolean);
const failures = [];

const forbiddenPaths = [
  /^AGENTS\.md$/,
  /(^|\/)AGENTS\.md$/,
  /^HANDOFF\.md$/,
  /^REQUESTS\.local\.md$/,
  /^CONTINUE_PROMPT\.local\.md$/,
  /(^|\/)[^/]+\.local\.md$/,
  /^output\//,
  /^tmp\//,
  /^DOX\//,
  /^\.dox\//,
  /^docs\/graph-and-preview-optimizations\.md$/,
  /^docs\/mesa-hero\.png$/,
  /^docs\/mesa-overlay\.png$/,
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|ed25519)$/,
];

const forbiddenContent = [
  { pattern: /\/Users\/ash\b/, label: "local user path" },
  { pattern: /\/Volumes\/ZimaOS-HD\b/, label: "private external volume path" },
  { pattern: /\bFrontier Vault\b/, label: "private vault name" },
];

const binaryExtensions = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
]);

const contentPolicyFiles = new Set([
  ".gitignore",
  "docs/release.md",
  "scripts/public-release-audit.mjs",
  "src/lib/publicReleaseAuditContract.test.ts",
]);

function extension(path) {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

for (const path of tracked) {
  for (const rule of forbiddenPaths) {
    if (rule.test(path)) {
      failures.push(`${path}: forbidden tracked path`);
      break;
    }
  }

  if (binaryExtensions.has(extension(path)) || contentPolicyFiles.has(path)) continue;

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }

  for (const { pattern, label } of forbiddenContent) {
    const match = pattern.exec(text);
    if (match) {
      failures.push(`${path}: contains ${label}`);
      break;
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("Public release audit failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Public release audit passed (${tracked.length} tracked files checked).\n`);
