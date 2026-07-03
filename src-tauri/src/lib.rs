// Mesa Tauri backend.
//
// The frontend does almost all of the work; the Rust side hosts the system
// webview, exposes the filesystem + native dialogs through the official Tauri
// plugins, and runs a tiny token-authenticated sync server (see sync.rs).
// Keeping the native surface small is what makes the app light: no bundled
// browser engine, a few hundred KB of Rust glue.

mod activity;
mod browse;
mod harness;
mod sync;
mod sync_core;
mod terminal;

#[cfg(desktop)]
const PI_AGENT_SHORTCUT_EVENT: &str = "mesa://global-agent";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state() == ShortcutState::Pressed {
                                let _ = app.emit(PI_AGENT_SHORTCUT_EVENT, ());
                            }
                        })
                        .build(),
                )?;

                // The global-shortcut plugin exposes generic Shift, not a
                // left/right shift distinction. The focused webview shortcut
                // below requires ShiftLeft; globally we register the closest
                // OS-level equivalent and intentionally do not bind Cmd+Space.
                let shortcut = "CommandOrControl+Shift+Space";
                if let Err(err) = app.global_shortcut().register(shortcut) {
                    eprintln!("Mesa could not register global shortcut {shortcut}: {err}");
                }
            }
            Ok(())
        })
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            sync::sync_start,
            sync::sync_stop,
            sync::sync_status,
            sync::sync_local_addr,
            sync::sync_identity,
            sync::sync_fetch_manifest,
            sync::sync_run,
            sync::sync_cancel,
            sync::sync_discovery_start,
            sync::sync_discovery_stop,
            activity::activity_start,
            activity::activity_stop,
            browse::browse_fetch,
            harness::harness_navigate,
            harness::harness_bounds,
            harness::harness_visibility,
            harness::harness_history,
            harness::harness_status,
            harness::harness_nudge,
            terminal::terminal_start,
            terminal::terminal_resize,
            terminal::terminal_write,
            terminal::terminal_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mesa");
}
