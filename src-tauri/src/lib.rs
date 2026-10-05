// Mesa's Tauri backend: native commands, desktop windows, and local sync.

mod activity;
mod bearer;
mod browse;
mod diagnostics;
mod harness;
mod secrets;
mod sync;
mod sync_core;
mod terminal;
mod vaultmove;
mod vaultread;
mod vaultscan;
mod vaultscope;
mod vaulttransaction;
mod vaultwatch;
mod vaultwrite;

#[cfg(desktop)]
const PI_AGENT_SHORTCUT_EVENT: &str = "mesa://global-agent";
const QUIT_REQUESTED_EVENT: &str = "mesa://quit-requested";
const SAFE_QUIT_MENU_ID: &str = "mesa-safe-quit";

#[derive(Default)]
struct QuitGuard(std::sync::atomic::AtomicBool);

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
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
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
            secrets::sync_secrets_read,
            secrets::sync_secrets_write,
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
            vaultmove::vault_purge_recovery,
            vaultscope::vault_authorize,
            vaultscope::vault_authorize_artifacts,
            vaultscope::vault_flush_file,
            vaultwrite::vault_write_atomic,
            vaulttransaction::vault_apply_research,
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
