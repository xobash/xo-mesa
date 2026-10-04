#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

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
  { pattern: /\/home\/[A-Za-z_][A-Za-z0-9_-]+\//, label: "personal home path" },
  { pattern: /\/Volumes\/[A-Za-z0-9][^\s/"']*/, label: "named external volume" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "private key" },
  { pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/, label: "access token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "access key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/, label: "Google API key" },
  { pattern: /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9-]+\.local\b(?!\.md\b)/i, label: "local hostname" },
  { pattern: new RegExp(["tel", "perion"].join(""), "i"), label: "old project name" },
];

function hasPersonalEmail(text) {
  for (const [address] of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
    if (/\.(?:png|jpe?g|svg|webp|avif)$/.test(domain)) continue;
    if (!domain.endsWith(".example") && domain !== "example.com" &&
        domain !== "example.org" && domain !== "example.net" &&
        !address.toLowerCase().endsWith("@users.noreply.github.com")) return true;
  }
  return false;
}

// Public fixtures and examples must use documentation ranges, not a device's
// LAN or carrier-grade NAT address. These ranges are never routable as peers.
function hasPrivateIpv4(text) {
  const matches = text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
  for (const [value] of matches) {
    const octets = value.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const [a, b] = octets;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return true;
    }
  }
  return false;
}

const approvedGenericIgnoreFiles = new Set([".gitignore", ".dockerignore"]);

function checkMarkdownTargets(file, text) {
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const targets = [
      ...line.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g),
      ...line.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/g),
    ];
    for (const match of targets) {
      let target = match[1].replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) continue;
      try { target = decodeURIComponent(target); }
      catch { failures.push(`${file}: malformed Markdown link ${match[1]}`); continue; }
      const resolved = target.startsWith("/")
        ? path.posix.normalize(target.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (!trackedSet.has(resolved)) failures.push(`${file}: broken Markdown file link ${match[1]}`);
    }
  }
}

for (const path of tracked) {
  const testFile = /\.test\.[cm]?[jt]sx?$/i.test(path);
  if ((testFile && !/^src\/.+\.test\.tsx?$/.test(path)) || /\.perf\.|\.pdf$/i.test(path)) {
    failures.push(`${path}: test fixture or example PDF is not a public release input`);
  }
  if (/(^|\/)\.[^/]*ignore$/.test(path) && !approvedGenericIgnoreFiles.has(path)) {
    failures.push(`${path}: unapproved ignore file`);
  }
  if (!approvedSet.has(path)) continue;
  const content = git(["show", `:${path}`], null);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const { pattern, label } of forbiddenContent) {
    if (pattern.test(text)) failures.push(`${path}: contains ${label}`);
  }
  // Third-party license text must retain upstream attribution verbatim.
  if (path !== "public/THIRD_PARTY_NOTICES.txt" && path !== "scripts/public-files.txt" &&
      hasPersonalEmail(text)) failures.push(`${path}: contains non-example email address`);
  if (hasPrivateIpv4(text)) failures.push(`${path}: contains private IPv4 literal`);
  if (path.endsWith(".md")) checkMarkdownTargets(path, text);
}

for (const line of git(["log", "--format=%an%x09%ae%x09%ai", "--all"]).split("\n").filter(Boolean)) {
  const [name, email, date] = line.split("\t");
  if (name !== "xobash" || email !== "xobash@users.noreply.github.com" || !date?.endsWith("+0000")) {
    failures.push("reachable commit has non-public or non-UTC identity metadata");
    break;
  }
}

if (failures.length > 0) {
  process.stderr.write("Public release audit failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Public release audit passed (${tracked.length} approved files checked).\n`);
