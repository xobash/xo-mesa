import { describe, expect, it } from "vitest";
import nativeApp from "../../src-tauri/src/lib.rs?raw";
import activity from "../../src-tauri/src/activity.rs?raw";
import sync from "../../src-tauri/src/sync.rs?raw";
import syncServer from "../../src-tauri/src/sync_server.rs?raw";
import syncIdentity from "../../src-tauri/src/sync_identity.rs?raw";
import vaultscope from "../../src-tauri/src/vaultscope.rs?raw";
import vaultwatch from "../../src-tauri/src/vaultwatch.rs?raw";

// Both native command forms dispatch blocking work away from the webview thread.
const OFF_MAIN_THREAD: Record<string, { source: string; commands: string[] }> = {
  "activity.rs": { source: activity, commands: ["activity_stop"] },
  "sync.rs": { source: sync, commands: ["sync_discovery_stop"] },
  "sync_server.rs": { source: syncServer, commands: ["sync_stop"] },
  "sync_identity.rs": { source: syncIdentity, commands: ["sync_identity"] },
  "vaultscope.rs": { source: vaultscope, commands: ["vault_flush_file", "vault_authorize", "vault_authorize_artifacts"] },
  "vaultwatch.rs": { source: vaultwatch, commands: ["vault_watch", "vault_unwatch"] },
};

function commandBody(source: string, name: string): { attribute: string; signature: string; body: string } {
  const match = new RegExp(`#\\[tauri::command[^\\]]*\\]\\s*(pub\\s+(?:async\\s+)?fn\\s+${name}\\b[^{]*)\\{`).exec(source);
  if (!match) throw new Error(`missing #[tauri::command] ${name}`);
  const start = match.index + match[0].length;
  let depth = 1;
  let end = start;
  while (depth > 0 && end < source.length) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
    end++;
  }
  return { attribute: match[0].slice(0, match[0].indexOf("pub")), signature: match[1], body: source.slice(start, end - 1) };
}

describe("native commands that block stay off the main thread", () => {
  for (const [file, { source, commands }] of Object.entries(OFF_MAIN_THREAD)) {
    for (const name of commands) {
      it(`${file}: ${name} is async and runs on a blocking worker`, () => {
        const { attribute, signature, body } = commandBody(source, name);
        const macroWorker = /command\(async\)/.test(attribute);
        const explicitWorker = /\basync\s+fn\b/.test(signature) && body.includes("spawn_blocking");
        expect(macroWorker || explicitWorker).toBe(true);
        if (name === "activity_stop") {
          const exit = nativeApp.slice(nativeApp.indexOf("if let tauri::RunEvent::Exit = event"));
          expect(exit).toContain("activity::stop_native()");
          expect(exit).not.toContain("activity::activity_stop()");
        }
      });
    }
  }
});

describe("watcher shutdown lock lifetime", () => {
  it("removes the watcher before dropping it outside the registry lock", () => {
    const { body } = commandBody(vaultwatch, "vault_unwatch");
    expect(body).toMatch(/let removed = [^;]*map\.remove\(&id\)[^;]*;\s*drop\(removed\)/s);
  });
});
