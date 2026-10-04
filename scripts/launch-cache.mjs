import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const stampPath = join(root, "src-tauri", "target", "mesa-launch-cache.json");
const mode = process.argv[2];

function filesUnder(path, files) {
  if (!existsSync(path)) return;
  for (const item of readdirSync(path, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const full = join(path, item.name);
    if (item.isDirectory()) {
      if (item.name === "target" || item.name === "gen" || item.name === "node_modules") continue;
      filesUnder(full, files);
    } else if (item.isFile()) {
      files.push(full);
    }
  }
}

function digest(paths) {
  const hash = createHash("sha256");
  const files = [];
  for (const path of paths) {
    const full = join(root, path);
    if (existsSync(full) && statSync(full).isFile()) files.push(full);
    else filesUnder(full, files);
  }
  files.sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stamps() {
  try { return JSON.parse(readFileSync(stampPath, "utf8")); }
  catch { return {}; }
}

function writeStamp(key, value) {
  const next = { ...stamps(), [key]: value };
  mkdirSync(join(root, "src-tauri", "target"), { recursive: true });
  writeFileSync(stampPath, JSON.stringify(next));
}

const deps = digest(["package.json", "package-lock.json"]) + `:${process.version}`;
const depsReady = existsSync(join(root, "node_modules", ".package-lock.json"))
  && existsSync(join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri"));
if (mode === "check-deps") process.exit(depsReady && stamps().deps === deps ? 0 : 1);
if (mode === "stamp-deps") { writeStamp("deps", deps); process.exit(0); }

const rustc = spawnSync("rustc", ["-Vv"], { encoding: "utf8" });
if (rustc.status !== 0) {
  console.error("Could not check the Rust toolchain for the launch cache.");
  process.exit(2);
}
const source = digest([
  "src", "src-tauri", "public", "scripts", "package.json", "package-lock.json",
  "vite.config.ts", "tsconfig.json", "index.html", "run.sh", "run.cmd",
  "DESIGN.md", "THIRD_PARTY_NOTICES.txt",
]);
const build = createHash("sha256")
  .update(`${source}:${deps}:${rustc.stdout}:${process.platform}:${process.arch}`)
  .digest("hex");
const artifact = process.platform === "darwin"
  ? join(root, "src-tauri", "target", "release", "bundle", "macos", "Mesa.app")
  : process.platform === "win32"
    ? join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "mesa.exe")
    : join(root, "src-tauri", "target", "release", "mesa");
if (mode === "check-build") process.exit(existsSync(artifact) && stamps().build === build ? 0 : 1);
if (mode === "stamp-build") { writeStamp("build", build); process.exit(0); }
console.error("Usage: node scripts/launch-cache.mjs check-deps|stamp-deps|check-build|stamp-build");
process.exit(2);
