// Menu-bar (macOS) / notification-area (Windows, Linux) status item: a small
// at-a-glance view of the workspace. The main renderer pushes a bounded
// snapshot; menu clicks are forwarded back to it as `mesa://tray-action`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TRAY_ID: &str = "mesa-tray";
pub(crate) const MENU_PREFIX: &str = "mesa-tray-";
pub(crate) const QUIT_ID: &str = "mesa-tray-quit";
const ACTION_EVENT: &str = "mesa://tray-action";
const TASK_PREFIX: &str = "mesa-tray-task-";
/// The menu stays compact: a few status lines and at most five tasks.
const MAX_TASKS: usize = 5;
const MAX_LABEL_CHARS: usize = 48;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTask {
    label: String,
    rel: String,
    line: u32,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySnapshot {
    vault: Option<String>,
    save: String,
    tasks_summary: String,
    tasks: Vec<TrayTask>,
    research: Option<String>,
    sync: String,
}

#[derive(Default)]
pub struct TrayState(Mutex<TraySnapshot>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayAction {
    action: &'static str,
    rel: Option<String>,
    line: Option<u32>,
}

fn clip(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_LABEL_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_LABEL_CHARS - 1).collect();
    out.push('…');
    out
}

fn bounded(mut snapshot: TraySnapshot) -> TraySnapshot {
    snapshot.tasks.truncate(MAX_TASKS);
    snapshot
}

fn info<R: Runtime>(app: &AppHandle<R>, id: &str, text: &str) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, clip(text), false, None::<&str>)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, s: &TraySnapshot) -> tauri::Result<Menu<R>> {
    let vault = s.vault.as_deref().unwrap_or("No vault open");
    let mut menu = MenuBuilder::new(app)
        .item(&info(app, "mesa-tray-vault", vault)?)
        .item(&info(app, "mesa-tray-save", &s.save)?)
        .separator()
        .item(&info(app, "mesa-tray-tasks-summary", &s.tasks_summary)?);
    for (i, task) in s.tasks.iter().enumerate() {
        menu = menu.text(
            format!("{TASK_PREFIX}{i}"),
            clip(&format!("  {}", task.label)),
        );
    }
    menu = menu.separator();
    if let Some(research) = &s.research {
        menu = menu.item(&info(app, "mesa-tray-research", research)?);
    }
    menu.item(&info(app, "mesa-tray-sync", &s.sync)?)
        .separator()
        .text("mesa-tray-open", "Open Mesa")
        .text("mesa-tray-search", "Search…")
        .text("mesa-tray-task-list", "Tasks…")
        .item(&MenuItem::with_id(
            app,
            "mesa-tray-settings",
            "Settings…",
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            QUIT_ID,
            "Quit Mesa",
            true,
            Some("CmdOrCtrl+Q"),
        )?)
        .build()
}

/// A monochrome four-point sparkle (Mesa's brand mark) for the macOS menu
/// bar, drawn as a template image so it follows the light/dark menu bar.
#[cfg(target_os = "macos")]
fn sparkle_template() -> tauri::image::Image<'static> {
    const SIZE: u32 = 44;
    const SAMPLES: u32 = 4;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let c = SIZE as f32 / 2.0;
    let r = SIZE as f32 * 0.46;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut hits = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = (x as f32 + (sx as f32 + 0.5) / SAMPLES as f32 - c).abs() / r;
                    let py = (y as f32 + (sy as f32 + 0.5) / SAMPLES as f32 - c).abs() / r;
                    // Astroid-like star: |x|^p + |y|^p <= 1 with p < 1.
                    if px.powf(0.6) + py.powf(0.6) <= 1.0 {
                        hits += 1;
                    }
                }
            }
            let alpha = (hits * 255 / (SAMPLES * SAMPLES)) as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &TraySnapshot::default())?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Mesa")
        .menu(&menu)
        .show_menu_on_left_click(true);
    #[cfg(target_os = "macos")]
    let builder = builder.icon(sparkle_template()).icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };
    builder.build(app)?;
    Ok(())
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Handles a tray menu click (ids starting with `MENU_PREFIX`, except Quit,
/// which the caller routes through the save-before-quit guard).
pub fn handle_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let action = match id {
        "mesa-tray-open" => "open",
        "mesa-tray-search" => "search",
        "mesa-tray-task-list" => "tasks",
        "mesa-tray-settings" => "settings",
        _ => match id
            .strip_prefix(TASK_PREFIX)
            .and_then(|i| i.parse::<usize>().ok())
        {
            Some(index) => {
                let task = app
                    .state::<TrayState>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|s| s.tasks.get(index).cloned());
                show_main(app);
                if let Some(task) = task {
                    let _ = app.emit_to(
                        "main",
                        ACTION_EVENT,
                        TrayAction {
                            action: "task",
                            rel: Some(task.rel),
                            line: Some(task.line),
                        },
                    );
                }
                return;
            }
            None => return,
        },
    };
    show_main(app);
    if action != "open" {
        let _ = app.emit_to(
            "main",
            ACTION_EVENT,
            TrayAction {
                action,
                rel: None,
                line: None,
            },
        );
    }
}

/// Replaces the tray menu with the renderer's current snapshot.
#[tauri::command]
pub fn tray_update<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    state: tauri::State<'_, TrayState>,
    snapshot: TraySnapshot,
) -> Result<(), String> {
    crate::require_main(window.label())?;
    let snapshot = bounded(snapshot);
    let menu = build_menu(&app, &snapshot).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    *state
        .0
        .lock()
        .map_err(|_| "tray state unavailable".to_string())? = snapshot;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_task_count_stay_bounded() {
        let long = "x".repeat(200);
        assert_eq!(clip(&long).chars().count(), MAX_LABEL_CHARS);
        assert!(clip(&long).ends_with('…'));
        assert_eq!(clip("  short  "), "short");
        let tasks = (0..12)
            .map(|i| TrayTask {
                label: format!("t{i}"),
                rel: "a.md".into(),
                line: i,
            })
            .collect();
        let snap = bounded(TraySnapshot {
            tasks,
            ..Default::default()
        });
        assert_eq!(snap.tasks.len(), MAX_TASKS);
    }
}
