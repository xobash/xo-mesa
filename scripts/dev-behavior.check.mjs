import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = join(dirname(fileURLToPath(import.meta.url)), "dev.mjs");
const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function runFakeCli(body) {
  const root = mkdtempSync(join(tmpdir(), "mesa-dev-test-"));
  folders.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules", "@tauri-apps", "cli"), { recursive: true });
  cpSync(source, join(root, "scripts", "dev.mjs"));
  writeFileSync(join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), body);
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
