import { describe, expect, it } from "vitest";
import nativeApp from "../../src-tauri/src/lib.rs?raw";
import activity from "../../src-tauri/src/activity.rs?raw";
import sync from "../../src-tauri/src/sync.rs?raw";
import vaultscope from "../../src-tauri/src/vaultscope.rs?raw";
import vaultwatch from "../../src-tauri/src/vaultwatch.rs?raw";

/**
 * Tauri 2 runs a `#[tauri::command]` that is not `async` on the main thread,
 * which also drives the webview event loop. These commands do blocking
 * filesystem work or join worker threads (the sync discovery thread waits out
 * a 500 ms socket timeout; the sync and activity servers poll every 250 ms),
 * so each must stay `async` and hand its body to `spawn_blocking`.
 * https://v2.tauri.app/develop/calling-rust/#async-commands
 */
const OFF_MAIN_THREAD: Record<string, { source: string; commands: string[] }> = {
  "activity.rs": { source: activity, commands: ["activity_stop"] },
  "sync.rs": { source: sync, commands: ["sync_stop", "sync_identity", "sync_discovery_stop"] },
  "vaultscope.rs": { source: vaultscope, commands: ["vault_flush_file", "vault_authorize", "vault_authorize_artifacts"] },
  "vaultwatch.rs": { source: vaultwatch, commands: ["vault_watch", "vault_unwatch"] },
};

function commandBody(source: string, name: string): { signature: string; body: string } {
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
  return { signature: match[1], body: source.slice(start, end - 1) };
}

describe("native commands that block stay off the main thread", () => {
  for (const [file, { source, commands }] of Object.entries(OFF_MAIN_THREAD)) {
    for (const name of commands) {
      it(`${file}: ${name} is async and runs on a blocking worker`, () => {
        const { signature, body } = commandBody(source, name);
        expect(signature).toMatch(/\basync\s+fn\b/);
        expect(body).toContain("spawn_blocking");
        if (name === "activity_stop") {
          const exit = nativeApp.slice(nativeApp.indexOf("if let tauri::RunEvent::Exit = event"));
          expect(exit).toContain("activity::stop_activity()");
          expect(exit).not.toContain("activity::activity_stop()");
        }
      });
    }
  }
});
