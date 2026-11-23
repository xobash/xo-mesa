import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fixtures = [];
afterEach(() => { for (const folder of fixtures.splice(0)) rmSync(folder, { recursive: true, force: true }); });

it("rebuilds after a source or dependency change and reuses unchanged output", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-launch-cache-"));
  fixtures.push(root);
  const put = (path, text) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  copyFileSync(resolve(import.meta.dirname, "launch-cache.mjs"), join(root, "launch-cache.mjs"));
  // The launcher lives under scripts in a real checkout.
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(root, "launch-cache.mjs"), join(root, "scripts", "launch-cache.mjs"));
  put("package.json", "{}");
  put("package-lock.json", "lock one");
  put("src/App.tsx", "first");
  put("node_modules/.package-lock.json", "installed");
  put("node_modules/.bin/tauri", "installed");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rustc"), "#!/bin/sh\necho rustc-test\n", { mode: 0o755 });
  const artifact = process.platform === "darwin"
    ? "src-tauri/target/release/bundle/macos/Mesa.app/Contents/MacOS/mesa"
    : process.platform === "win32"
      ? "src-tauri/target/x86_64-pc-windows-msvc/release/mesa.exe"
      : "src-tauri/target/release/mesa";
  put(artifact, "binary");
  const run = mode => spawnSync(process.execPath, [join(root, "scripts", "launch-cache.mjs"), mode], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
  }).status;
  assert.equal(run("check-deps"), 1);
  assert.equal(run("stamp-deps"), 0);
  assert.equal(run("check-deps"), 0);
  assert.equal(run("check-build"), 1);
  assert.equal(run("stamp-build"), 0);
  assert.equal(run("check-build"), 0);
  put("src/App.tsx", "second");
  assert.equal(run("check-build"), 1);
  assert.equal(run("stamp-build"), 0);
  put("package-lock.json", "lock two");
  assert.equal(run("check-deps"), 1);
  assert.equal(run("check-build"), 1);
});

it("walks a 300-level source tree on a small stack and still sees its deepest file", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-launch-deep-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(resolve(import.meta.dirname, "launch-cache.mjs"), join(root, "scripts", "launch-cache.mjs"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "package-lock.json"), "lock");
  const deepest = join(root, "src", ...Array(300).fill("d"));
  mkdirSync(deepest, { recursive: true });
  writeFileSync(join(deepest, "leaf.ts"), "first");
  const artifact = process.platform === "darwin" ? "src-tauri/target/release/bundle/macos/Mesa.app" : "src-tauri/target/release/mesa";
  mkdirSync(join(root, artifact), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rustc"), "#!/bin/sh\necho rustc-test\n", { mode: 0o755 });
  // 80 KB is enough for Node itself but not for one JS frame per folder level.
  const run = mode => spawnSync(process.execPath, ["--stack-size=80", join(root, "scripts", "launch-cache.mjs"), mode], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
  });
  const stamped = run("stamp-build");
  assert.equal(stamped.status, 0, stamped.stderr);
  assert.equal(run("check-build").status, 0);
  writeFileSync(join(deepest, "leaf.ts"), "second");
  assert.equal(run("check-build").status, 1);
});
