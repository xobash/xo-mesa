// Mesa's Tauri backend: native commands, desktop windows, and local sync.

mod activity;
mod bearer;
mod browse;
mod diagnostics;
mod recents;
mod secrets;
mod surfaces;
mod sync;
mod sync_core;
mod sync_policy;
mod terminal;
mod vaultmove;
mod vaultops;
mod vaultread;
mod vaultscan;
mod vaultscope;
mod vaulttransaction;
mod vaultwatch;
mod vaultwrite;

pub(crate) fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("This operation belongs to the main workspace".into())
    }
}
pub(crate) fn require_agent_surface(label: &str) -> Result<(), String> {
    if label == "main" || label.starts_with("agent-") {
        Ok(())
    } else {
        Err("This operation requires a Pi surface".into())
    }
}

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

/// Top-level navigation is limited to the app's own origin. Mesa renders
/// untrusted note content in its privileged webviews; a link or script that
/// navigates them would show attacker pages under the app's title with IPC
/// access, so everything else is refused.
fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        // `asset` serves approved vault files to PDF/media frames.
        "tauri" | "asset" => true,
        "about" => url.as_str() == "about:blank" || url.as_str() == "about:srcdoc",
        "http" | "https" => {
            let host = url.host_str();
            matches!(host, Some("tauri.localhost" | "asset.localhost"))
                || (cfg!(debug_assertions) && matches!(host, Some("localhost" | "127.0.0.1")))
        }
        _ => false,
    }
}

fn pdf_blob_grants(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::collections::HashSet<String>>>
{
    static GRANTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::collections::HashSet<String>>>,
    > = std::sync::OnceLock::new();
    GRANTS.get_or_init(Default::default)
}

fn valid_pdf_blob(url: &str) -> bool {
    let Some(inner) = url
        .strip_prefix("blob:")
        .and_then(|inner| inner.parse::<tauri::Url>().ok())
    else {
        return false;
    };
    let origin = inner.origin().ascii_serialization();
    let app_origin = matches!(
        origin.as_str(),
        "http://tauri.localhost" | "https://tauri.localhost"
    ) || (inner.scheme() == "tauri" && inner.host_str() == Some("localhost"))
        || (cfg!(debug_assertions)
            && matches!(
                origin.as_str(),
                "http://localhost:1420" | "http://127.0.0.1:1420"
            ));
    app_origin
        && inner.username().is_empty()
        && inner.password().is_none()
        && inner.query().is_none()
        && inner.fragment().is_none()
        && inner.path().trim_start_matches('/').len() == 36
}

fn grant_pdf_blob(label: &str, url: String, allow: bool) -> Result<(), String> {
    if !(label == "main" || label.starts_with("doc-") || label.starts_with("panel-"))
        || !valid_pdf_blob(&url)
    {
        return Err("Only Mesa document surfaces may register an app PDF preview".into());
    }
    let mut grants = pdf_blob_grants()
        .lock()
        .map_err(|error| error.to_string())?;
    if allow {
        let entries = grants.entry(label.to_string()).or_default();
        if entries.len() >= 8 && !entries.contains(&url) {
            return Err("Too many PDF previews".into());
        }
        entries.insert(url);
    } else if let Some(entries) = grants.get_mut(label) {
        entries.remove(&url);
        if entries.is_empty() {
            grants.remove(label);
        }
    }
    Ok(())
}

#[tauri::command]
fn navigation_pdf_preview(window: tauri::Window, url: String, allow: bool) -> Result<(), String> {
    grant_pdf_blob(window.label(), url, allow)
}

fn registered_pdf_blob(label: &str, url: &tauri::Url) -> bool {
    url.scheme() == "blob"
        && pdf_blob_grants().lock().is_ok_and(|grants| {
            grants
                .get(label)
                .is_some_and(|entries| entries.contains(url.as_str()))
        })
}

fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("mesa-navigation-guard")
        .on_navigation(|webview, url| {
            navigation_allowed(url) || registered_pdf_blob(webview.label(), url)
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(navigation_guard());
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
            std::thread::spawn(|| {
                activity::sweep_stale_extensions();
                // A quick crash/restart leaves fresh entries; revisit after their grace period.
                std::thread::sleep(std::time::Duration::from_secs(60));
                activity::sweep_stale_extensions();
            });
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
            navigation_pdf_preview,
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
            terminal::terminal_start,
            terminal::terminal_attach,
            terminal::terminal_prepare_handoff,
            terminal::terminal_snapshot,
            terminal::terminal_subscribe,
            terminal::terminal_unsubscribe,
            terminal::terminal_resize,
            terminal::terminal_write,
            terminal::terminal_stop,
            vaultscan::vault_scan,
            vaultread::vault_read_text,
            vaultread::vault_read_bytes,
            vaultread::vault_text_fingerprints,
            vaultmove::vault_rename_no_replace,
            vaultmove::vault_purge_recovery,
            vaultscope::vault_authorize,
            vaultscope::vault_revoke,
            recents::vault_recents,
            recents::vault_recent_resolve,
            recents::vault_storage_id,
            surfaces::workspace_open_surface,
            vaultscope::vault_authorize_artifacts,
            vaultscope::vault_flush_file,
            vaultwrite::vault_write_atomic,
            vaultops::vault_create_directory,
            vaultops::vault_move_to_recovery,
            vaultops::vault_restore_recovery,
            vaultops::vault_list_recovery,
            vaultops::vault_recover_artifact,
            secrets::sync_secrets_import,
            secrets::sync_secrets_generate,
            secrets::sync_secrets_show,
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
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                use tauri::Manager;
                if let Ok(mut grants) = pdf_blob_grants().lock() {
                    grants.remove(label);
                }
                terminal::revoke_window(&app.state::<terminal::TerminalState>(), label);
            }
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
                let _ = activity::stop_native();
            }
        });
}

#[cfg(test)]
mod navigation_tests {
    use super::navigation_allowed;

    fn allowed(url: &str) -> bool {
        navigation_allowed(&url.parse().unwrap())
    }

    #[test]
    fn pdf_blob_allowance_is_exact_window_scoped_and_revocable() {
        let url = "blob:http://tauri.localhost/00000000-0000-0000-0000-000000000000";
        let parsed = url.parse().unwrap();
        assert!(!allowed(url));
        super::grant_pdf_blob("doc-test", url.into(), true).unwrap();
        assert!(super::registered_pdf_blob("doc-test", &parsed));
        assert!(!super::registered_pdf_blob("main", &parsed));
        assert!(!super::registered_pdf_blob(
            "doc-test",
            &"blob:http://tauri.localhost/10000000-0000-0000-0000-000000000000"
                .parse()
                .unwrap()
        ));
        super::grant_pdf_blob("doc-test", url.into(), false).unwrap();
        assert!(!super::registered_pdf_blob("doc-test", &parsed));
        for invalid in [
            "data:application/pdf,x",
            "blob:https://evil.example/00000000-0000-0000-0000-000000000000",
            "blob:http://tauri.localhost/short",
            "blob:http://asset.localhost/00000000-0000-0000-0000-000000000000",
            "blob:tauri://evil/00000000-0000-0000-0000-000000000000",
        ] {
            assert!(super::grant_pdf_blob("doc-test", invalid.into(), true).is_err());
        }
        assert!(super::grant_pdf_blob("agent-test", url.into(), true).is_err());
    }

    #[test]
    fn only_app_origins_may_be_navigated_to() {
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://tauri.localhost/index.html"));
        assert!(allowed("about:blank"));
        assert!(allowed("asset://localhost/vault/a.pdf"));
        assert!(allowed("http://asset.localhost/vault/a.pdf"));
        for url in [
            "data:text/html,<h1>untrusted</h1>",
            "blob:tauri://localhost/00000000-0000-0000-0000-000000000000",
            "about:config",
            "https://evil.example/x",
            "http://evil.example/",
            "http://tauri.localhost.evil.example/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
        ] {
            assert!(!allowed(url), "{url}");
        }
        assert_eq!(allowed("http://localhost:1420/"), cfg!(debug_assertions));
    }
}

#[cfg(test)]
mod authority_tests {
    #[test]
    fn native_sensitive_commands_reject_secondary_window_labels() {
        for label in ["doc-one", "panel-one", "agent-one", ""] {
            assert!(super::require_main(label).is_err());
        }
        assert!(super::require_main("main").is_ok());
        assert!(super::require_agent_surface("main").is_ok());
        assert!(super::require_agent_surface("agent-one").is_ok());
        assert!(super::require_agent_surface("doc-one").is_err());
    }
}
