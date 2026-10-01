// Mesa Tauri backend.
//
// The frontend does almost all of the work; the Rust side hosts the system
// webview, exposes the filesystem + native dialogs through the official Tauri
// plugins, and runs a tiny token-authenticated sync server (see sync.rs).
// Keeping the native surface small is what makes the app light: no bundled
// browser engine, a few hundred KB of Rust glue.

mod activity;
mod browse;
mod diagnostics;
mod harness;
mod sync;
mod sync_core;
mod terminal;
mod vaultmove;
mod vaultread;
mod vaultscan;
mod vaultscope;
mod vaultwatch;

#[cfg(desktop)]
const PI_AGENT_SHORTCUT_EVENT: &str = "mesa://global-agent";
const QUIT_REQUESTED_EVENT: &str = "mesa://quit-requested";
const SAFE_QUIT_MENU_ID: &str = "mesa-safe-quit";

#[derive(Default)]
struct QuitGuard(std::sync::atomic::AtomicBool);

#[cfg(desktop)]
struct InstanceLock {
    _file: std::fs::File,
}

#[cfg(desktop)]
fn acquire_instance_lock(path: &std::path::Path) -> std::io::Result<Option<InstanceLock>> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(InstanceLock { _file: file })),
        Err(error) => {
            let error: std::io::Error = error.into();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

#[tauri::command]
fn quit_guard_arm(state: tauri::State<'_, QuitGuard>) {
    state.0.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn quit_guard_disarm(state: tauri::State<'_, QuitGuard>) {
    state.0.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn quit_after_save(app: tauri::AppHandle, state: tauri::State<'_, QuitGuard>) {
    state.0.store(false, std::sync::atomic::Ordering::SeqCst);
    // Deliver the invoke response before asking the event loop to exit.
    std::thread::spawn(move || app.exit(0));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            #[cfg(target_os = "macos")]
            {
                let app_menu = menu
                    .items()?
                    .into_iter()
                    .next()
                    .and_then(|item| item.as_submenu().cloned())
                    .ok_or_else(|| {
                        tauri::Error::Io(std::io::Error::other("missing Mesa app menu"))
                    })?;
                let default_quit =
                    app_menu.items()?.into_iter().last().ok_or_else(|| {
                        tauri::Error::Io(std::io::Error::other("missing Quit item"))
                    })?;
                app_menu.remove(&default_quit)?;
                app_menu.append(&tauri::menu::MenuItem::with_id(
                    app,
                    SAFE_QUIT_MENU_ID,
                    format!("Quit {}", app.package_info().name),
                    true,
                    Some("Cmd+Q"),
                )?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() != SAFE_QUIT_MENU_ID {
                return;
            }
            use tauri::{Emitter, Manager};
            if app
                .state::<QuitGuard>()
                .0
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                let _ = app.emit(QUIT_REQUESTED_EVENT, ());
            } else {
                app.exit(0);
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri::Manager;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

                let config = app.path().app_config_dir()?;
                std::fs::create_dir_all(&config)?;
                match acquire_instance_lock(&config.join("mesa-instance.lock"))? {
                    Some(lock) => app.manage(lock),
                    None => {
                        eprintln!("Mesa is already running.");
                        std::process::exit(0);
                    }
                };

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
        .manage(vaultscope::VaultScopeState::default())
        .manage(QuitGuard::default())
        .manage(vaultwatch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            sync::sync_start,
            sync::sync_stop,
            sync::sync_status,
            sync::sync_local_addr,
            sync::sync_identity,
            sync::sync_fetch_manifest,
            sync::sync_run,
            sync::sync_cancel,
            sync::sync_retire_peer,
            sync::sync_discovery_start,
            sync::sync_discovery_stop,
            activity::activity_start,
            activity::activity_set_context,
            activity::deep_research_respond,
            activity::activity_stop,
            browse::browse_fetch,
            diagnostics::diagnostics_process_tree,
            harness::harness_navigate,
            harness::harness_bounds,
            harness::harness_visibility,
            harness::harness_history,
            harness::harness_status,
            harness::harness_nudge,
            terminal::terminal_start,
            terminal::terminal_attach,
            terminal::terminal_snapshot,
            terminal::terminal_resize,
            terminal::terminal_write,
            terminal::terminal_stop,
            vaultscan::vault_scan,
            vaultread::vault_read_text,
            vaultread::vault_text_fingerprints,
            vaultmove::vault_rename_no_replace,
            vaultscope::vault_authorize,
            vaultscope::vault_authorize_artifacts,
            quit_guard_arm,
            quit_guard_disarm,
            quit_after_save,
            vaultwatch::vault_watch,
            vaultwatch::vault_unwatch
        ])
        .build(tauri::generate_context!())
        .expect("error while running Mesa")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                use tauri::{Emitter, Manager};
                if app
                    .state::<QuitGuard>()
                    .0
                    .load(std::sync::atomic::Ordering::SeqCst)
                    && app.get_webview_window("main").is_some()
                    && app.emit(QUIT_REQUESTED_EVENT, ()).is_ok()
                {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                // Nothing else tears these down. Managed state is not dropped
                // on exit, so without this the Pi PTY child outlives the app
                // (see `terminal::stop_all_sessions`) and the loopback activity
                // server keeps its thread and its bound port until the process
                // is reaped. Both are best-effort: exiting must not be blocked.
                terminal::stop_all_sessions(&app.state::<terminal::TerminalState>());
                let _ = activity::activity_stop();
            }
        });
}

#[cfg(all(test, desktop))]
mod instance_tests {
    use super::acquire_instance_lock;

    #[test]
    fn second_instance_cannot_take_live_lock_and_crash_releases_it() {
        let dir = std::env::temp_dir().join(format!("mesa-instance-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("instance.lock");
        let first = acquire_instance_lock(&path).unwrap().unwrap();
        assert!(acquire_instance_lock(&path).unwrap().is_none());
        drop(first);
        assert!(acquire_instance_lock(&path).unwrap().is_some());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(dir);
    }
}
