// Prepend the Rust user bin directory and launch the project-local Tauri CLI.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS_TARGET } from "./tauri-targets.mjs";

const env = { ...process.env };
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
// Dev and release builds use the exact reviewed Node; npm only warns (EBADENGINE).
const nodePin = existsSync(join(projectRoot, ".node-version")) ? readFileSync(join(projectRoot, ".node-version"), "utf8").trim() : "";
if (process.versions.node !== nodePin) {
  console.error(
    `Mesa needs Node.js ${nodePin || "from .node-version"}, but this is Node.js ${process.versions.node}. ` +
      "Run run.cmd (Windows) or run.sh, which install the pinned Node.js, or switch to that version and retry."
  );
  process.exit(1);
}
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";

function prependPath(dir) {
  if (!existsSync(dir)) return;
  const current = env[pathKey] || "";
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.includes(dir)) {
    env[pathKey] = dir + delimiter + current;
  }
  // Some Windows child processes consult PATH while others preserve Path.
  env.PATH = env[pathKey];
}

const cargoBin = join(homedir(), ".cargo", "bin");
prependPath(dirname(process.execPath));
prependPath(cargoBin);

// `npm run mesa` → dev; `npm run mesa build` / mesa:build → build; extra args
// (e.g. a stray "dev") collapse to the intended subcommand.
const passed = process.argv.slice(2).filter(Boolean);
const sub = passed.includes("build") ? "build" : "dev";
const extra = passed.filter((a) => a !== "dev" && a !== "build");

if (sub === "build") {
  if (process.platform === "win32") {
    const rustup = spawnSync("rustup", ["target", "add", WINDOWS_TARGET], {
      stdio: "inherit",
      env,
      shell: false,
    });
    if (rustup.status !== 0) {
      console.warn(
        "Mesa could not auto-install the Windows Rust target; Windows builds will only work if it is already installed."
      );
    }
  }
}

const tauriArgs = [sub, ...extra];
if (sub === "build" && process.platform === "win32") {
  tauriArgs.push("--target", WINDOWS_TARGET);
  if (!extra.includes("--no-bundle") && !extra.includes("--bundles")) {
    tauriArgs.push("--bundles", "msi", "nsis");
  }
}

if (!existsSync(tauriCli)) {
  console.error("Mesa could not find the local Tauri CLI. Run npm install, then retry npm run mesa.");
  process.exit(1);
}

// The Tauri CLI checks the dev URL once, right after it starts
// `beforeDevCommand`, then sleeps two seconds before it checks again. Start
// the dev server here and hand over only when its port accepts, so that first
// check succeeds. A caller's own --config keeps the CLI's own start.
const DEV_SERVER_POLL_MS = 25;
const DEV_SERVER_MAX_POLLS = 1200;
const viteCli = join(projectRoot, "node_modules", "vite", "bin", "vite.js");

function devServerAddress() {
  try {
    const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));
    const url = new URL(config.build.devUrl);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? { host: url.hostname, port } : null;
  } catch {
    return null;
  }
}

function accepts({ host, port }) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); });
  });
}

/** Resolves true when the server accepts, false when it exited or never did. */
async function waitForDevServer(address, server) {
  for (let poll = 0; poll < DEV_SERVER_MAX_POLLS; poll += 1) {
    if (server.exitCode !== null || server.signalCode !== null) return false;
    if (await accepts(address)) return true;
    await new Promise((wake) => setTimeout(wake, DEV_SERVER_POLL_MS));
  }
  return false;
}

function runTauri(args, devServer) {
  const child = spawn(process.execPath, [tauriCli, ...args], { stdio: "inherit", env, shell: false });
  const stopDevServer = () => {
    if (devServer && devServer.exitCode === null) devServer.kill();
  };
  child.on("exit", (code, signal) => {
    stopDevServer();
    process.exit(signal ? 1 : (code ?? 1));
  });
  child.on("error", (err) => {
    stopDevServer();
    console.error("Failed to launch Tauri:", err.message);
    process.exit(1);
  });
  if (!devServer) return;
  // The app cannot run without its dev server.
  devServer.on("exit", () => {
    console.error("The Mesa dev server stopped; closing Mesa.");
    child.kill();
  });
  // A signal sent to the launcher alone must not leave the dev server behind:
  // pass it to Tauri, whose exit stops the server.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
}

const address = sub === "dev" ? devServerAddress() : null;
const ownsConfig = extra.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="));
if (!address || ownsConfig || !existsSync(viteCli)) {
  runTauri(tauriArgs, null);
} else if (await accepts(address)) {
  console.error(`Mesa's dev port ${address.port} is already in use. Close the other dev server, then retry.`);
  process.exit(1);
} else {
  const devServer = spawn(process.execPath, [viteCli], { cwd: projectRoot, stdio: "inherit", env, shell: false });
  devServer.on("error", (err) => console.error("Failed to start the Mesa dev server:", err.message));
  if (await waitForDevServer(address, devServer)) {
    runTauri(["dev", "--config", JSON.stringify({ build: { beforeDevCommand: null } }), ...extra], devServer);
  } else {
    if (devServer.exitCode === null) devServer.kill();
    console.error(`The Mesa dev server did not start on port ${address.port}.`);
    process.exit(1);
  }
}
