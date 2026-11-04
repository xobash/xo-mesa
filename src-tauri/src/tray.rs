// Menu-bar (macOS) / notification-area (Windows, Linux) status item: a small
// at-a-glance view of the workspace. The main renderer pushes a bounded
// snapshot; menu clicks are forwarded back to it as `mesa://tray-action`.
// On macOS a left click opens the glass popover (`tray.html`) instead. The
// popover window exists only while open, so it costs no memory when closed;
// it holds no vault authority and reaches the workspace only through
// `tray_popover_request` and `tray_popover_act`, which the main window serves.

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Duration;
use std::time::Instant;
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
pub(crate) const POPOVER_LABEL: &str = "tray";
const POPOVER_REQUEST_EVENT: &str = "mesa://tray-popover-request";
/// Landscape: the mini graph beside a menu-width column.
const POPOVER_WIDTH: f64 = 620.0;
/// The popover sizes itself to its content between these bounds (and the
/// space below the menu bar); it stays hidden until that first fit.
const POPOVER_MIN_HEIGHT: f64 = 300.0;
const POPOVER_MAX_HEIGHT: f64 = 560.0;
/// Shows the popover even if its page never reports a height.
#[cfg(target_os = "macos")]
const FIRST_FIT_FALLBACK: Duration = Duration::from_millis(700);
/// A click on the status item first blurs (and closes) an open popover; a
/// click this soon after that close is the same gesture, not a reopen.
#[cfg(target_os = "macos")]
const REOPEN_DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_QUERY_CHARS: usize = 256;
const MAX_REL_BYTES: usize = 1024;
const MAX_ID_BYTES: usize = 128;

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

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayAction {
    action: &'static str,
    rel: Option<String>,
    line: Option<u32>,
    id: Option<String>,
    query: Option<String>,
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
        .menu(&menu);
    // macOS: left click opens the popover, right click keeps the native menu.
    #[cfg(target_os = "macos")]
    let builder = builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_popover(tray.app_handle(), rect);
            }
        })
        .icon(sparkle_template())
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };
    builder.build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
static POPOVER_OPENS: AtomicU64 = AtomicU64::new(0);

fn last_popover_close() -> &'static Mutex<Option<Instant>> {
    static CLOSED: Mutex<Option<Instant>> = Mutex::new(None);
    &CLOSED
}

/// Closes the popover; its webview process ends with the window.
pub fn close_popover<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        if let Ok(mut closed) = last_popover_close().lock() {
            *closed = Some(Instant::now());
        }
        let _ = window.destroy();
    }
}

/// Top-left corner (logical points) that centres the popover under the status
/// item and keeps it inside the monitor's work area.
#[cfg(any(target_os = "macos", test))]
fn popover_origin(
    icon: (f64, f64, f64, f64),
    area: (f64, f64, f64, f64),
    size: (f64, f64),
) -> (f64, f64) {
    const GAP: f64 = 6.0;
    const MARGIN: f64 = 8.0;
    let (ix, iy, iw, ih) = icon;
    let (ax, ay, aw, ah) = area;
    let max_x = (ax + aw - size.0 - MARGIN).max(ax + MARGIN);
    let max_y = (ay + ah - size.1 - MARGIN).max(ay + MARGIN);
    let x = (ix + iw / 2.0 - size.0 / 2.0).clamp(ax + MARGIN, max_x);
    let y = (iy + ih + GAP).clamp(ay, max_y);
    (x, y)
}

#[cfg(target_os = "macos")]
fn toggle_popover<R: Runtime>(app: &AppHandle<R>, icon: tauri::Rect) {
    if app.get_webview_window(POPOVER_LABEL).is_some() {
        close_popover(app);
        return;
    }
    let recently_closed = last_popover_close()
        .lock()
        .ok()
        .and_then(|closed| *closed)
        .is_some_and(|at| at.elapsed() < REOPEN_DEBOUNCE);
    if recently_closed {
        return;
    }
    if let Err(err) = open_popover(app, icon) {
        eprintln!("Mesa could not open its menu bar popover: {err}");
    }
}

#[cfg(target_os = "macos")]
fn open_popover<R: Runtime>(app: &AppHandle<R>, icon: tauri::Rect) -> tauri::Result<()> {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    let monitor = app
        .monitor_from_point(
            icon.position.to_physical::<f64>(1.0).x,
            icon.position.to_physical::<f64>(1.0).y,
        )?
        .or(app.primary_monitor()?);
    let scale = monitor.as_ref().map_or(1.0, |m| m.scale_factor());
    let pos = icon.position.to_logical::<f64>(scale);
    let size = icon.size.to_logical::<f64>(scale);
    let area = monitor.as_ref().map_or((0.0, 0.0, 1e5, 1e5), |m| {
        let a = m.work_area();
        let p = a.position.to_logical::<f64>(scale);
        let s = a.size.to_logical::<f64>(scale);
        (p.x, p.y, s.width, s.height)
    });
    let (x, y) = popover_origin(
        (pos.x, pos.y, size.width, size.height),
        area,
        (POPOVER_WIDTH, POPOVER_MAX_HEIGHT),
    );
    tauri::WebviewWindowBuilder::new(
        app,
        POPOVER_LABEL,
        tauri::WebviewUrl::App("tray.html".into()),
    )
    .title("Mesa")
    .inner_size(
        POPOVER_WIDTH,
        POPOVER_MAX_HEIGHT.min(area.1 + area.3 - y - 8.0),
    )
    .position(x, y)
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .transparent(true)
    .shadow(true)
    .visible(false)
    .effects(
        EffectsBuilder::new()
            .effect(Effect::Popover)
            .state(EffectState::Active)
            .radius(12.0)
            .build(),
    )
    .build()?;
    if let Ok(mut max) = popover_max_height().lock() {
        *max = (area.1 + area.3 - y - 8.0).clamp(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT);
    }
    // Only this popover's fallback may reveal it: a popover reopened within the
    // fallback delay must wait for its own first fit.
    let opened = POPOVER_OPENS.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_FIT_FALLBACK);
        if POPOVER_OPENS.load(Ordering::SeqCst) != opened {
            return;
        }
        if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
            if !window.is_visible().unwrap_or(true) {
                reveal(&window);
            }
        }
    });
    Ok(())
}

fn popover_max_height() -> &'static Mutex<f64> {
    static MAX: Mutex<f64> = Mutex::new(POPOVER_MAX_HEIGHT);
    &MAX
}

fn reveal<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Fits the popover to its content height and shows it on the first fit.
fn fit_popover<R: Runtime>(app: &AppHandle<R>, height: f64) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    let max = popover_max_height()
        .lock()
        .map_or(POPOVER_MAX_HEIGHT, |max| *max);
    let height = height.clamp(POPOVER_MIN_HEIGHT, max.max(POPOVER_MIN_HEIGHT));
    let _ = window.set_size(tauri::LogicalSize::new(POPOVER_WIDTH, height));
    if !window.is_visible().unwrap_or(true) {
        reveal(&window);
    }
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
                            ..Default::default()
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
                ..Default::default()
            },
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PopoverAction {
    action: String,
    rel: Option<String>,
    id: Option<String>,
    query: Option<String>,
    height: Option<f64>,
}

enum PopoverEffect {
    Close,
    Fit(f64),
    Quit,
    /// Forward to main; the popover stays open (toggles that update in place).
    Background(TrayAction),
    /// Close the popover, show main, then forward.
    Foreground(TrayAction),
}

fn bounded_text(value: Option<String>, max_bytes: usize) -> Result<String, String> {
    let value = value.ok_or("Missing menu bar action target")?;
    if value.is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err("Invalid menu bar action target".into());
    }
    Ok(value)
}

/// Maps a popover request onto a fixed action set with bounded arguments.
/// Paths and vault ids stay opaque here; main resolves them against its own
/// catalog and native recents record before acting.
fn classify(request: PopoverAction) -> Result<PopoverEffect, String> {
    let PopoverAction {
        action,
        rel,
        id,
        query,
        height,
    } = request;
    let simple = |action: &'static str| TrayAction {
        action,
        ..Default::default()
    };
    Ok(match action.as_str() {
        "close" => PopoverEffect::Close,
        "fit" => match height {
            Some(h) if h.is_finite() => PopoverEffect::Fit(h),
            _ => return Err("Invalid popover height".into()),
        },
        "quit" => PopoverEffect::Quit,
        "sync-toggle" => PopoverEffect::Background(simple("sync-toggle")),
        "sync-now" => PopoverEffect::Background(simple("sync-now")),
        "open" => PopoverEffect::Foreground(simple("open")),
        "new-note" => PopoverEffect::Foreground(simple("new-note")),
        "daily" => PopoverEffect::Foreground(simple("daily")),
        "pi" => PopoverEffect::Foreground(simple("pi")),
        "graph" => PopoverEffect::Foreground(simple("graph")),
        "settings" => PopoverEffect::Foreground(simple("settings")),
        "tasks" => PopoverEffect::Foreground(simple("tasks")),
        "search" => {
            let query: String = query
                .unwrap_or_default()
                .chars()
                .take(MAX_QUERY_CHARS)
                .collect();
            PopoverEffect::Foreground(TrayAction {
                action: "search",
                query: Some(query),
                ..Default::default()
            })
        }
        "note" => PopoverEffect::Foreground(TrayAction {
            action: "note",
            rel: Some(bounded_text(rel, MAX_REL_BYTES)?),
            ..Default::default()
        }),
        "vault" => {
            let id = bounded_text(id, MAX_ID_BYTES)?;
            if !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err("Invalid menu bar action target".into());
            }
            PopoverEffect::Foreground(TrayAction {
                action: "vault",
                id: Some(id),
                ..Default::default()
            })
        }
        _ => return Err("Unknown menu bar action".into()),
    })
}

fn require_popover(label: &str) -> Result<(), String> {
    if label == POPOVER_LABEL {
        Ok(())
    } else {
        Err("This operation belongs to the menu bar popover".into())
    }
}

/// Asks main for fresh popover state (and search results for `query`); main
/// replies with `mesa://tray-popover-state` to the popover.
#[tauri::command]
pub fn tray_popover_request<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    query: Option<String>,
) -> Result<(), String> {
    require_popover(window.label())?;
    let query: String = query
        .unwrap_or_default()
        .chars()
        .take(MAX_QUERY_CHARS)
        .collect();
    app.emit_to(
        "main",
        POPOVER_REQUEST_EVENT,
        serde_json::json!({ "query": query }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tray_popover_act<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    request: PopoverAction,
) -> Result<(), String> {
    require_popover(window.label())?;
    match classify(request)? {
        PopoverEffect::Close => close_popover(&app),
        PopoverEffect::Fit(height) => fit_popover(&app, height),
        PopoverEffect::Quit => {
            close_popover(&app);
            crate::request_quit(&app);
        }
        PopoverEffect::Background(action) => {
            app.emit_to("main", ACTION_EVENT, action)
                .map_err(|e| e.to_string())?;
        }
        PopoverEffect::Foreground(action) => {
            close_popover(&app);
            show_main(&app);
            if action.action != "open" {
                app.emit_to("main", ACTION_EVENT, action)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
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

    fn act(action: &str, rel: Option<&str>, id: Option<&str>) -> Result<PopoverEffect, String> {
        classify(PopoverAction {
            action: action.into(),
            rel: rel.map(Into::into),
            id: id.map(Into::into),
            query: None,
            height: None,
        })
    }

    #[test]
    fn popover_actions_are_a_fixed_bounded_set() {
        assert!(act("rm -rf", None, None).is_err());
        assert!(act("note", None, None).is_err());
        assert!(act("note", Some(""), None).is_err());
        assert!(act("note", Some(&"a".repeat(MAX_REL_BYTES + 1)), None).is_err());
        assert!(act("vault", None, Some("../x")).is_err());
        assert!(act("vault", None, Some(&"a".repeat(MAX_ID_BYTES + 1))).is_err());
        assert!(matches!(
            act("note", Some("Notes/a.md"), None),
            Ok(PopoverEffect::Foreground(TrayAction { action: "note", .. }))
        ));
        assert!(matches!(
            act("vault", None, Some("v-01_ab")),
            Ok(PopoverEffect::Foreground(TrayAction {
                action: "vault",
                ..
            }))
        ));
        assert!(matches!(
            act("sync-toggle", None, None),
            Ok(PopoverEffect::Background(_))
        ));
        assert!(matches!(act("quit", None, None), Ok(PopoverEffect::Quit)));
        let search = classify(PopoverAction {
            action: "search".into(),
            rel: None,
            id: None,
            query: Some("q".repeat(1000)),
            height: None,
        });
        let Ok(PopoverEffect::Foreground(TrayAction { query: Some(q), .. })) = search else {
            panic!("search must forward a query");
        };
        assert_eq!(q.chars().count(), MAX_QUERY_CHARS);
        let fit = |height: Option<f64>| {
            classify(PopoverAction {
                action: "fit".into(),
                rel: None,
                id: None,
                query: None,
                height,
            })
        };
        assert!(matches!(fit(Some(420.0)), Ok(PopoverEffect::Fit(h)) if h == 420.0));
        assert!(fit(Some(f64::NAN)).is_err());
        assert!(fit(None).is_err());
        assert!(require_popover("main").is_err());
        assert!(require_popover(POPOVER_LABEL).is_ok());
    }

    #[test]
    fn popover_sits_under_the_icon_inside_the_work_area() {
        let area = (0.0, 25.0, 1440.0, 875.0);
        // Centred under a mid-bar icon, just below the menu bar.
        assert_eq!(
            popover_origin((700.0, 0.0, 30.0, 24.0), area, (340.0, 620.0)),
            (545.0, 30.0)
        );
        // An icon at the right edge keeps the popover on screen.
        assert_eq!(
            popover_origin((1420.0, 0.0, 30.0, 24.0), area, (340.0, 620.0)),
            (1092.0, 30.0)
        );
    }
}
