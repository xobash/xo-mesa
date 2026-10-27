import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { releaseTargetDir, WINDOWS_TARGET } from "./tauri-targets.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const source = join(scripts, "dev.mjs");
const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fakeRoot(body) {
  const root = mkdtempSync(join(tmpdir(), "mesa-dev-test-"));
  folders.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules", "@tauri-apps", "cli"), { recursive: true });
  cpSync(source, join(root, "scripts", "dev.mjs"));
  cpSync(join(scripts, "tauri-targets.mjs"), join(root, "scripts", "tauri-targets.mjs"));
  writeFileSync(join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), body);
  return root;
}

function runFakeCli(body) {
  const root = fakeRoot(body);
  return spawnSync(process.execPath, [join(root, "scripts", "dev.mjs")], { encoding: "utf8" });
}

test("dev launcher returns failure when Tauri exits by signal", () => {
  const result = runFakeCli('process.kill(process.pid, "SIGTERM");');
  assert.equal(result.status, 1);
});

test("dev launcher preserves a successful Tauri exit", () => {
  const result = runFakeCli("process.exit(0);");
  assert.equal(result.status, 0);
});

test("Windows release build targets the folder release packaging reads", { skip: process.platform === "win32" && "uses a POSIX fake rustup" }, () => {
  const root = fakeRoot(
    'require("node:fs").writeFileSync(require("node:path").join(__dirname, "args.json"), JSON.stringify(process.argv.slice(2)));'
  );
  writeFileSync(join(root, "node_modules", "@tauri-apps", "cli", "package.json"), '{"type":"commonjs"}');
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rustup"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "rustup"), 0o755);
  const asWindows = "data:text/javascript," + encodeURIComponent('Object.defineProperty(process, "platform", { value: "win32" });');
  const result = spawnSync(process.execPath, ["--import", asWindows, join(root, "scripts", "dev.mjs"), "build"], {
    encoding: "utf8",
    env: { PATH: bin, HOME: root, USERPROFILE: root },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(join(root, "node_modules", "@tauri-apps", "cli", "args.json"), "utf8"));
  const target = args[args.indexOf("--target") + 1];
  assert.deepEqual(args, ["build", "--target", WINDOWS_TARGET, "--bundles", "msi", "nsis"]);
  assert.equal(releaseTargetDir("windows"), `src-tauri/target/${target}/release`);
});
