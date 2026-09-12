// Launch `tauri dev` / `tauri build` with Rust's bin dir on PATH.
//
// run.sh installs Rust locally via rustup with --no-modify-path, so a plain
// `npm run mesa` outside run.sh can fail with "failed to run 'cargo metadata'
// … No such file or directory" because `cargo` isn't on the shell's PATH.
// This launcher prepends ~/.cargo/bin (and the Windows equivalent) so the
// command works from any shell, then forwards to the local Tauri CLI.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
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
  if (process.platform === "darwin") {
    const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    const rustup = spawnSync("rustup", ["target", "add", ...targets], {
      stdio: "inherit",
      env,
      shell: false,
    });
    if (rustup.status !== 0) {
      console.warn(
        "Mesa could not auto-install the macOS Rust targets; universal builds will only work if both targets are already installed."
      );
    }
  }
  if (process.platform === "win32") {
    const rustup = spawnSync("rustup", ["target", "add", "x86_64-pc-windows-msvc"], {
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
if (sub === "build" && process.platform === "darwin") {
  tauriArgs.push("--target", "universal-apple-darwin");
}
if (sub === "build" && process.platform === "win32") {
  tauriArgs.push("--target", "x86_64-pc-windows-msvc");
  tauriArgs.push("--bundles", "msi", "nsis");
}

if (!existsSync(tauriCli)) {
  console.error("Mesa could not find the local Tauri CLI. Run npm install, then retry npm run mesa.");
  process.exit(1);
}

const child = spawn(process.execPath, [tauriCli, ...tauriArgs], {
  stdio: "inherit",
  env,
  shell: false,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch Tauri:", err.message);
  process.exit(1);
});
