#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

function git(args, encoding = "utf8", input, maxBuffer = 128 * 1024 * 1024) {
  const result = spawnSync("git", args, { encoding, input, maxBuffer });
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

// Check every external native module, including #[path] overrides in test/fuzz crates.
for (const file of tracked.filter(file => file.startsWith("src-tauri/") && file.endsWith(".rs"))) {
  const source = git(["show", `:${file}`]);
  for (const match of source.matchAll(/^\s*(?:#\[path\s*=\s*"([^"]+)"\]\s*)?(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)) {
    const dir = path.posix.dirname(file);
    const stem = path.posix.basename(file, ".rs");
    const base = path.posix.join(dir, ["lib", "main", "mod"].includes(stem) ? "" : stem, match[2]);
    const candidates = match[1] ? [path.posix.normalize(path.posix.join(dir, match[1]))] : [`${base}.rs`, `${base}/mod.rs`];
    if (!candidates.some(candidate => trackedSet.has(candidate))) failures.push(`${file}: required native module ${match[2]} is missing`);
  }
}
if (trackedSet.has("package.json")) {
  const scripts = JSON.parse(git(["show", ":package.json"])).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    for (const match of command.matchAll(/(?:^|[;&|]\s*)node(?:\s+--[^\s]+)*\s+([\w/.-]+\.(?:mjs|cjs|js))(?=\s|$)/g)) {
      if (!trackedSet.has(match[1])) failures.push(`package.json: script ${name} requires missing ${match[1]}`);
    }
  }
}

const forbiddenContent = [
  // Windows forms include JSON-escaped double backslashes and forward slashes.
  { pattern: /(?:\/Users\/|[A-Z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))[^\s/\\]+/i, label: "personal filesystem path" },
  { pattern: /\/home\/[A-Za-z_][A-Za-z0-9_-]+\//, label: "personal home path" },
  { pattern: /(?:^|[\s"'`=(:,])\/root\/[^\s"'`]/, label: "root home path" },
  // macOS per-user temporary folders carry a random user-specific component.
  { pattern: /\/var\/folders\/[A-Za-z0-9_+-]{2}\/[A-Za-z0-9_+-]{20,}/, label: "per-user temporary path" },
  { pattern: /\/Volumes\/[A-Za-z0-9][^\s/"']*/, label: "named external volume" },
  { pattern: /-----BEGIN (?:(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/, label: "private key" },
  { pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/, label: "access token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "access key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/, label: "Google API key" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, label: "API secret key" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, label: "Slack token" },
  { pattern: /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9-]+\.local\b(?!\.md\b)/i, label: "local hostname" },
  { pattern: /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9-]+\.(?:lan|internal|corp|home\.arpa)\b(?![(-])/i, label: "private network hostname" },
  // IPv6 unique-local and link-local literals.
  { pattern: /(?:^|[^0-9A-Za-z:])(?:fd[0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f]{0,4}:/i, label: "private IPv6 literal" },
  { pattern: new RegExp(["tel", "perion"].join(""), "i"), label: "old project name" },
];

function hasPersonalEmail(text) {
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const address = match[0];
    // GitHub SSH remotes use a service account, not a personal email address.
    if (address === "git" + "@github.com" && /^:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git/.test(text.slice(match.index + address.length))) continue;
    const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
    if (/\.(?:png|jpe?g|svg|webp|avif)$/.test(domain)) continue;
    if (!domain.endsWith(".example") && domain !== "example.com" &&
        domain !== "example.org" && domain !== "example.net" &&
        !address.toLowerCase().endsWith("@users.noreply.github.com")) return true;
  }
  return false;
}

// Public fixtures and examples must use documentation ranges, not a device's
// LAN, carrier-grade NAT or link-local address. The well-known cloud metadata
// address 169.254.169.254 names no device and stays allowed for SSRF tests.
function hasPrivateIpv4(text) {
  const matches = text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
  for (const [value] of matches) {
    const octets = value.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const [a, b] = octets;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254 && value !== "169.254.169.254")) {
      return true;
    }
  }
  return false;
}

const approvedGenericIgnoreFiles = new Set([".gitignore", ".dockerignore"]);

function checkMarkdownTargets(file, text) {
  // CommonMark fences: a backtick info string holds no backtick, and only the
  // same character, at least as long, with nothing after it, closes.
  let fence = "";
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/.exec(line);
    if (marker && !fence && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = marker[1];
      continue;
    }
    if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      fence = "";
      continue;
    }
    if (fence) continue;
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

function privateWorkingPath(path) {
  return /(^|\/)(?:agents|handoff|claude)\.md$|(^|\/)DOX-.*\.local\.md$|\.local\.md$|^output\/|(^|\/)\.(?:claude|codex|cursor)\//i.test(path);
}

for (const path of tracked) {
  if (privateWorkingPath(path)) {
    failures.push(`${path}: private working document is not a public input`);
  }
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

// Private document paths are checked in the candidate ancestry; secret bytes
// remain checked across every fetched public ref below.
for (const entry of git(["rev-list", "--objects", "HEAD"]).trim().split("\n")) {
  const name = entry.slice(entry.indexOf(" ") + 1);
  if (privateWorkingPath(name)) failures.push(`historical path ${name}: private working document is not a public input`);
}

// Inspect each reachable historical blob once; report categories without private bytes.
const objects = git(["rev-list", "--objects", "--all"]).trim().split("\n").filter(Boolean);
const ids = objects.map(line => line.split(" ")[0]);
const sizes = git(["cat-file", "--batch-check=%(objectsize)"], "utf8", ids.join("\n") + "\n")
  .trim().split("\n").map(Number);
if (sizes.length !== objects.length || sizes.some(size => !Number.isSafeInteger(size) || size < 0)) {
  throw new Error("Invalid historical object sizes.");
}
let historicalBlobs = 0;
for (let start = 0; start < objects.length;) {
  let stop = start, bytes = 0;
  while (stop < objects.length && (stop === start || bytes + sizes[stop] + 128 <= 32 * 1024 * 1024)) {
    bytes += sizes[stop] + 128;
    stop++;
  }
  // Bound each response by object bytes, rather than accumulated history size.
  const batch = git(["cat-file", "--batch"], null, ids.slice(start, stop).join("\n") + "\n",
    Math.max(64 * 1024 * 1024, bytes));
  let offset = 0;
  for (let index = start; index < stop; index++) {
    const end = batch.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete historical object response.");
    const [id, kind, length] = batch.toString("ascii", offset, end).split(" ");
    const size = Number(length);
    if (id !== ids[index] || size !== sizes[index] || end + 1 + size >= batch.length) {
      throw new Error("Invalid historical object bounds.");
    }
    const content = batch.subarray(end + 1, end + 1 + size);
    offset = end + size + 2;
    if (kind !== "blob" || content.includes(0)) continue;
    historicalBlobs++;
    const name = objects[index].slice(id.length + 1), text = content.toString("utf8");
    for (const { pattern, label } of forbiddenContent) {
      if (pattern.test(text)) failures.push(`historical blob ${id}: contains ${label}`);
    }
    if (name !== "public/THIRD_PARTY_NOTICES.txt" && name !== "scripts/public-files.txt" && hasPersonalEmail(text)) {
      failures.push(`historical blob ${id}: contains non-example email address`);
    }
    if (hasPrivateIpv4(text)) failures.push(`historical blob ${id}: contains private IPv4 literal`);
  }
  start = stop;
}

// GitHub-generated PR preview/squash commits use the same owner's numeric
// no-reply alias as author and GitHub's service identity as committer. None of
// these exposes a personal email address. Every date must be UTC.
const publicAuthorEmails = new Set([
  "xobash@users.noreply.github.com",
  "164987616+xobash@users.noreply.github.com",
]);
const publicIdentity = (name, email) => name === "xobash" && publicAuthorEmails.has(email);
const publicCommitter = (name, email) => publicIdentity(name, email) ||
  (name === "GitHub" && email === "noreply" + "@github.com");
const assistantName = /\b(?:claude|anthropic|chatgpt|openai|codex|copilot)\b/i;
// The name list also covers assistant session trailers and session links.
// A generated-by footer links a tool or names an assistant; build output notes such as
// "Generated by scripts/third-party-notices.mjs" stay valid.
const generatedFooter = /^\W*Generated (?:with|by)\s+(?:\[|an?\s+(?:AI|assistant)\b|.*\b(?:AI|assistant)\b)/im;
const assistantTrailers = [/^\s*Co-Authored-By:/im, generatedFooter, assistantName];
const commits = git(["log", "--all", "--format=%an%x09%ae%x09%ai%x09%cn%x09%ce%x09%ci%x09%B%x00"])
  .split("\0").map(entry => entry.replace(/^\n/, "")).filter(Boolean);
for (const entry of commits) {
  const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = entry.split("\t");
  if (!publicIdentity(authorName, authorEmail) || !authorDate?.endsWith("+0000") ||
      !publicCommitter(committerName, committerEmail) || !committerDate?.endsWith("+0000")) {
    failures.push("reachable commit has non-public or non-UTC identity metadata");
    break;
  }
}
for (const entry of commits) {
  const message = entry.split("\t").slice(6).join("\t");
  if (assistantTrailers.some(pattern => pattern.test(message))) {
    failures.push("reachable commit message has assistant trailer, footer or identity");
    break;
  }
}
// Branch and tag names are public too; they must not name an assistant.
for (const ref of git(["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
  if (/(?:^|[/_.-])(?:claude|anthropic|chatgpt|openai|codex|copilot)(?=$|[/_.-])/i.test(ref)) {
    failures.push("reachable ref name contains an assistant identity");
    break;
  }
}

if (failures.length > 0) {
  process.stderr.write("Public release audit failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Public release audit passed (${tracked.length} approved files checked; ${historicalBlobs} reachable text blobs).\n`);
