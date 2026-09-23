#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString() || `git ${args[0]} failed\n`);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
const approvedInFileOrder = git(["show", ":scripts/public-files.txt"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const approved = [...approvedInFileOrder].sort();
const failures = [];

if (new Set(approved).size !== approved.length) {
  failures.push("public file allowlist contains duplicate paths");
}
if (approvedInFileOrder.some((path, index) => path !== approved[index])) {
  failures.push("public file allowlist must be sorted");
}

const trackedSet = new Set(tracked);
const approvedSet = new Set(approved);
for (const path of tracked) {
  if (!approvedSet.has(path)) failures.push(`${path}: not approved for publication`);
}
for (const path of approved) {
  if (!trackedSet.has(path)) failures.push(`${path}: approved path is missing`);
}

const forbiddenContent = [
  { pattern: /(?:\/Users\/|[A-Z]:\\Users\\)[^\s/\\]+/i, label: "personal filesystem path" },
  { pattern: /\/Volumes\/(?!NAS(?:\/|["']))[A-Za-z0-9][^\s/"']*/, label: "named external volume" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "private key" },
  { pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/, label: "access token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "access key" },
];

const approvedGenericIgnoreFiles = new Set([".gitignore", ".dockerignore"]);

for (const path of tracked) {
  if (/(^|\/)\.[^/]*ignore$/.test(path) && !approvedGenericIgnoreFiles.has(path)) {
    failures.push(`${path}: private exclusion file`);
  }
  if (!approvedSet.has(path)) continue;
  const content = git(["show", `:${path}`], null);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const { pattern, label } of forbiddenContent) {
    if (pattern.test(text)) failures.push(`${path}: contains ${label}`);
  }
}

if (failures.length > 0) {
  process.stderr.write("Public release audit failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Public release audit passed (${tracked.length} approved files checked).\n`);
