import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
  writeFileSync(join(root, ".node-version"), `${process.versions.node}\r\n`);
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

test("dev launcher refuses a Node.js other than the .node-version pin", () => {
  const root = fakeRoot('require("node:fs").writeFileSync(require("node:path").join(__dirname, "ran"), "");');
  writeFileSync(join(root, "node_modules", "@tauri-apps", "cli", "package.json"), '{"type":"commonjs"}');
  for (const pin of ["22.22.2", ""]) {
    writeFileSync(join(root, ".node-version"), pin);
    const result = spawnSync(process.execPath, [join(root, "scripts", "dev.mjs"), "build"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Mesa needs Node\\.js .*this is Node\\.js ${process.versions.node.replaceAll(".", "\\.")}`));
  }
  assert.equal(existsSync(join(root, "node_modules", "@tauri-apps", "cli", "ran")), false, "Tauri ran under the wrong Node");
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

// --- Dev server hand-over ---------------------------------------------------
// The Tauri CLI checks the dev URL once and then sleeps two seconds, so the
// launcher must have the dev server accepting before the CLI starts.

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

const FAKE_DEV_SERVER = `
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const port = Number(new URL(require(join(process.cwd(), "src-tauri", "tauri.conf.json")).build.devUrl).port);
require("node:net").createServer((socket) => socket.end()).listen(port, "127.0.0.1", () => {
  writeFileSync(join(process.cwd(), "dev-server.pid"), String(process.pid));
});
`;
// Records whether the dev server already accepts, and the arguments it got.
const FAKE_TAURI = `
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = join(__dirname, "..", "..", "..");
const port = Number(new URL(require(join(root, "src-tauri", "tauri.conf.json")).build.devUrl).port);
const report = (connected) => {
  writeFileSync(join(root, "tauri-saw.json"), JSON.stringify({ connected, args: process.argv.slice(2) }));
  process.exit(0);
};
const socket = require("node:net").connect({ host: "127.0.0.1", port });
socket.once("connect", () => report(true));
socket.once("error", () => report(false));
`;

async function devRoot(devServerBody) {
  const root = fakeRoot(FAKE_TAURI);
  mkdirSync(join(root, "src-tauri"));
  mkdirSync(join(root, "node_modules", "vite", "bin"), { recursive: true });
  const port = await freePort();
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ build: { devUrl: `http://127.0.0.1:${port}` } }));
  writeFileSync(join(root, "node_modules", "vite", "bin", "vite.js"), devServerBody);
  return { root, port };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("dev launcher hands Tauri a dev server that already accepts, then stops it", async () => {
  const { root } = await devRoot(FAKE_DEV_SERVER);
  const result = spawnSync(process.execPath, [join(root, "scripts", "dev.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const saw = JSON.parse(readFileSync(join(root, "tauri-saw.json"), "utf8"));
  assert.equal(saw.connected, true, "Tauri started before the dev server accepted");
  assert.deepEqual(saw.args, ["dev", "--config", JSON.stringify({ build: { beforeDevCommand: null } })]);
  const pid = Number(readFileSync(join(root, "dev-server.pid"), "utf8"));
  let stopped = false;
  for (let attempt = 0; attempt < 100 && !stopped; attempt += 1) {
    stopped = !alive(pid);
    if (!stopped) await new Promise((wake) => setTimeout(wake, 20));
  }
  assert.equal(stopped, true, "the dev server outlived Tauri");
});

test("dev launcher fails without running Tauri when the dev server cannot start", async () => {
  const { root } = await devRoot("process.exit(1);");
  const result = spawnSync(process.execPath, [join(root, "scripts", "dev.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dev server did not start/);
  assert.equal(existsSync(join(root, "tauri-saw.json")), false, "Tauri ran without a dev server");
});

test("dev launcher refuses a dev port that another process holds", async () => {
  const { root, port } = await devRoot(FAKE_DEV_SERVER);
  const holder = createServer();
  await new Promise((done) => holder.listen(port, "127.0.0.1", done));
  try {
    const result = spawnSync(process.execPath, [join(root, "scripts", "dev.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already in use/);
    assert.equal(existsSync(join(root, "tauri-saw.json")), false);
    assert.equal(existsSync(join(root, "dev-server.pid")), false, "a second dev server started");
  } finally {
    await new Promise((done) => holder.close(done));
  }
});

test("dev launcher leaves the dev server to Tauri when the caller passes --config", async () => {
  const { root } = await devRoot(FAKE_DEV_SERVER);
  const result = spawnSync(process.execPath, [join(root, "scripts", "dev.mjs"), "--config", "{}"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const saw = JSON.parse(readFileSync(join(root, "tauri-saw.json"), "utf8"));
  assert.deepEqual(saw.args, ["dev", "--config", "{}"]);
  assert.equal(existsSync(join(root, "dev-server.pid")), false, "the launcher started a dev server");
});
