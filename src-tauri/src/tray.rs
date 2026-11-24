// Menu-bar (macOS) / notification-area (Windows, Linux) status item: a small
// at-a-glance view of the workspace. The main renderer pushes a bounded
// snapshot; menu clicks are forwarded back to it as `mesa://tray-action`.
// On macOS and Windows a left click opens the popover (`tray.html`) and a
// right click shows a native menu; Linux delivers no tray clicks, so its menu
// carries the status. The popover window exists only while open, so it costs
// no memory when closed; it holds no vault authority and reaches the
// workspace only through `tray_popover_request` and `tray_popover_act`,
// which the main window serves.

// Linux opens no popover; its tests still cover the shared placement.
#[cfg_attr(target_os = "linux", allow(dead_code))]
#[path = "tray_placement.rs"]
mod placement;

use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "macos", windows))]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
#[cfg(any(target_os = "macos", windows))]
use std::time::Duration;
use std::time::Instant;
use tauri::menu::{Menu, MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TRAY_ID: &str = "mesa-tray";
pub(crate) const MENU_PREFIX: &str = "mesa-tray-";
pub(crate) const QUIT_ID: &str = "mesa-tray-quit";
const OPEN_ID: &str = "mesa-tray-open";
const SETTINGS_ID: &str = "mesa-tray-settings";
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
/// space beside the bar); it stays hidden until that first fit.
const POPOVER_MIN_HEIGHT: f64 = 300.0;
const POPOVER_MAX_HEIGHT: f64 = 560.0;
/// Shows the popover even if its page never reports a height.
#[cfg(any(target_os = "macos", windows))]
const FIRST_FIT_FALLBACK: Duration = Duration::from_millis(700);
/// A click on the status item first blurs (and closes) an open popover; a
/// click this soon after that close is the same gesture, not a reopen.
#[cfg(any(target_os = "macos", windows))]
const REOPEN_DEBOUNCE: Duration = Duration::from_millis(300);
/// Like a system menu: 6 pt under the macOS menu bar item; Windows 11
/// flyouts keep 12 px from the taskbar and the screen edges.
#[cfg(target_os = "macos")]
const POPOVER_SPACING: placement::Spacing = placement::Spacing {
    gap: 6.0,
    bar_gap: 0.0,
    margin: 8.0,
};
#[cfg(not(target_os = "macos"))]
const POPOVER_SPACING: placement::Spacing = placement::Spacing {
    gap: 12.0,
    bar_gap: 12.0,
    margin: 12.0,
};
/// Windows click-away safety net: how often it checks the foreground window,
/// and for at most how long one popover is watched.
#[cfg(windows)]
const FOCUS_TICK: Duration = Duration::from_millis(200);
#[cfg(windows)]
const FOCUS_MAX_TICKS: u32 = 18_000;
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

/// Clipped menu text with a literal `&`. Menus read a single `&` as a
/// mnemonic marker (Windows underlines the next letter, macOS and GTK drop
/// it), so user text such as a vault named "R&D" escapes it as `&&`.
fn menu_label(text: &str) -> String {
    clip(text).replace('&', "&&")
}

fn bounded(mut snapshot: TraySnapshot) -> TraySnapshot {
    snapshot.tasks.truncate(MAX_TASKS);
    snapshot
}

/// Which native menu the status item carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuStyle {
    /// Status rows, tasks and commands (macOS right click, Linux any click).
    Full,
    /// Windows right click: the popover carries the status, so the menu holds
    /// only Show Mesa, Settings and Quit, with no shortcut text (shortcuts do
    /// nothing inside a notification-area menu).
    Short,
}

/// Whether a left click opens the native menu. macOS and Windows open the
/// popover instead; Linux (and other Unix trays) deliver no click events, so
/// the menu must open on any click there.
fn menu_on_left_click(os: &str) -> bool {
    !matches!(os, "macos" | "windows")
}

fn menu_style(os: &str) -> MenuStyle {
    if os == "windows" {
        MenuStyle::Short
    } else {
        MenuStyle::Full
    }
}

/// One native menu row; kept as data so tests read the menu without a runtime.
#[derive(Debug, PartialEq)]
enum Entry {
    Item {
        id: String,
        label: String,
        enabled: bool,
        accelerator: Option<&'static str>,
    },
    Separator,
}

fn info(id: &str, text: &str) -> Entry {
    Entry::Item {
        id: id.into(),
        label: menu_label(text),
        enabled: false,
        accelerator: None,
    }
}

fn command(id: &str, label: &str, accelerator: Option<&'static str>) -> Entry {
    Entry::Item {
        id: id.into(),
        label: label.into(),
        enabled: true,
        accelerator,
    }
}

fn menu_entries(style: MenuStyle, s: &TraySnapshot) -> Vec<Entry> {
    if style == MenuStyle::Short {
        return vec![
            command(OPEN_ID, "Show Mesa", None),
            command(SETTINGS_ID, "Settings", None),
            Entry::Separator,
            command(QUIT_ID, "Quit Mesa", None),
        ];
    }
    let vault = s.vault.as_deref().unwrap_or("No vault open");
    let mut entries = vec![
        info("mesa-tray-vault", vault),
        info("mesa-tray-save", &s.save),
        Entry::Separator,
        info("mesa-tray-tasks-summary", &s.tasks_summary),
    ];
    for (i, task) in s.tasks.iter().enumerate() {
        entries.push(command(
            &format!("{TASK_PREFIX}{i}"),
            &menu_label(&format!("  {}", task.label)),
            None,
        ));
    }
    entries.push(Entry::Separator);
    if let Some(research) = &s.research {
        entries.push(info("mesa-tray-research", research));
    }
    entries.extend([
        info("mesa-tray-sync", &s.sync),
        Entry::Separator,
        command(OPEN_ID, "Open Mesa", None),
        command("mesa-tray-search", "Search…", None),
        command("mesa-tray-task-list", "Tasks…", None),
        command(SETTINGS_ID, "Settings…", Some("CmdOrCtrl+,")),
        Entry::Separator,
        command(QUIT_ID, "Quit Mesa", Some("CmdOrCtrl+Q")),
    ]);
    entries
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    style: MenuStyle,
    s: &TraySnapshot,
) -> tauri::Result<Menu<R>> {
    let mut menu = MenuBuilder::new(app);
    for entry in menu_entries(style, s) {
        menu = match entry {
            Entry::Separator => menu.separator(),
            Entry::Item {
                id,
                label,
                enabled,
                accelerator,
            } => menu.item(&MenuItem::with_id(app, id, label, enabled, accelerator)?),
        };
    }
    menu.build()
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
    let os = std::env::consts::OS;
    let menu = build_menu(app, menu_style(os), &TraySnapshot::default())?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Mesa")
        .menu(&menu)
        .show_menu_on_left_click(menu_on_left_click(os));
    // macOS and Windows: left click opens the popover, right click shows the
    // native menu.
    #[cfg(any(target_os = "macos", windows))]
    let builder = builder.on_tray_icon_event(|tray, event| {
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
    });
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

#[cfg(any(target_os = "macos", windows))]
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

/// Where the open popover hangs: kept so each content fit re-anchors it (a
/// popover above a bottom taskbar grows upward).
#[derive(Clone, Copy)]
struct Anchor {
    icon: placement::Rect,
    area: placement::Rect,
    edge: placement::Edge,
    scale: f64,
    /// Logical height limit between the bar and the far work-area edge.
    max_height: f64,
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
impl Anchor {
    fn new(
        icon: placement::Rect,
        monitor: placement::Rect,
        area: placement::Rect,
        scale: f64,
    ) -> Self {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let edge = placement::bar_edge(icon, monitor, area);
        let room = placement::room(icon, area, edge, POPOVER_SPACING, scale) / scale;
        Self {
            icon,
            area,
            edge,
            scale,
            max_height: room.clamp(POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT),
        }
    }

    /// Physical size and top-left corner for a content `height` (logical).
    fn frame(&self, height: f64) -> ((f64, f64), (f64, f64)) {
        let height = height.clamp(POPOVER_MIN_HEIGHT, self.max_height);
        let size = (
            (POPOVER_WIDTH * self.scale).round(),
            (height * self.scale).round(),
        );
        let at = placement::origin(
            self.icon,
            self.area,
            self.edge,
            size,
            POPOVER_SPACING,
            self.scale,
        );
        (size, (at.0.round(), at.1.round()))
    }
}

fn popover_anchor() -> &'static Mutex<Option<Anchor>> {
    static ANCHOR: Mutex<Option<Anchor>> = Mutex::new(None);
    &ANCHOR
}

#[cfg(any(target_os = "macos", windows))]
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
        eprintln!("Mesa could not open its tray popover: {err}");
    }
}

/// Whether the open popover's window has a system backdrop the page may let
/// show through (Windows only; the macOS page is always transparent).
static POPOVER_BACKDROP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The status item's monitor. Tray rects and monitors are physical pixels;
/// macOS works in logical points (Cocoa's global coordinates, which tao
/// converts with the window's current screen, not the item's), Windows in
/// physical pixels (per-monitor DPI).
#[cfg(any(target_os = "macos", windows))]
fn anchor_for<R: Runtime>(app: &AppHandle<R>, icon: tauri::Rect) -> tauri::Result<Anchor> {
    let pos = icon.position.to_physical::<f64>(1.0);
    let size = icon.size.to_physical::<f64>(1.0);
    let icon = placement::Rect::new(pos.x, pos.y, size.width, size.height);
    let (cx, cy) = (icon.x + icon.w / 2.0, icon.y + icon.h / 2.0);
    let monitor = app.monitor_from_point(cx, cy)?.or(app.primary_monitor()?);
    let Some(monitor) = monitor else {
        let everywhere = placement::Rect::new(-1e5, -1e5, 2e5, 2e5);
        return Ok(Anchor::new(icon, everywhere, everywhere, 1.0));
    };
    let bounds = placement::Rect::new(
        f64::from(monitor.position().x),
        f64::from(monitor.position().y),
        f64::from(monitor.size().width),
        f64::from(monitor.size().height),
    );
    let work = monitor.work_area();
    let area = placement::Rect::new(
        f64::from(work.position.x),
        f64::from(work.position.y),
        f64::from(work.size.width),
        f64::from(work.size.height),
    );
    let scale = monitor.scale_factor();
    #[cfg(target_os = "macos")]
    let (icon, bounds, area, scale) = (
        icon.scaled(1.0 / scale),
        bounds.scaled(1.0 / scale),
        area.scaled(1.0 / scale),
        1.0,
    );
    Ok(Anchor::new(icon, bounds, area, scale))
}

#[cfg(any(target_os = "macos", windows))]
fn open_popover<R: Runtime>(app: &AppHandle<R>, icon: tauri::Rect) -> tauri::Result<()> {
    let anchor = anchor_for(app, icon)?;
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        POPOVER_LABEL,
        tauri::WebviewUrl::App("tray.html".into()),
    )
    .title("Mesa")
    .inner_size(POPOVER_WIDTH, anchor.max_height)
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .transparent(true)
    .shadow(true)
    .visible(false);
    // macOS: created at its final logical spot, as before; only fits resize it.
    #[cfg(target_os = "macos")]
    let builder = {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        let (_, (x, y)) = anchor.frame(anchor.max_height);
        builder
            .position(x, y)
            .visible_on_all_workspaces(true)
            .effects(
                EffectsBuilder::new()
                    .effect(Effect::Popover)
                    .state(EffectState::Active)
                    .radius(12.0)
                    .build(),
            )
    };
    #[cfg_attr(not(windows), allow(unused_variables))]
    let window = builder.build()?;
    if let Ok(mut slot) = popover_anchor().lock() {
        *slot = Some(anchor);
    }
    #[cfg(windows)]
    {
        POPOVER_BACKDROP.store(
            windows_popover::apply_backdrop(&window),
            std::sync::atomic::Ordering::SeqCst,
        );
        place(&window, &anchor, anchor.max_height);
    }
    // Only this popover's fallback may reveal it: a popover reopened within the
    // fallback delay must wait for its own first fit.
    let opened = POPOVER_OPENS.fetch_add(1, Ordering::SeqCst) + 1;
    let fallback_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_FIT_FALLBACK);
        if POPOVER_OPENS.load(Ordering::SeqCst) != opened {
            return;
        }
        if let Some(window) = fallback_app.get_webview_window(POPOVER_LABEL) {
            if !window.is_visible().unwrap_or(true) {
                reveal(&window);
            }
        }
    });
    #[cfg(windows)]
    {
        let watch_app = app.clone();
        std::thread::spawn(move || windows_popover::watch_foreground(&watch_app, opened));
    }
    Ok(())
}

/// Windows-only calls, kept to the two DWM attributes and the foreground
/// check (windows-sys 0.61: `DwmSetWindowAttribute`, `GetForegroundWindow`).
#[cfg(windows)]
mod windows_popover {
    use super::{close_popover, FOCUS_MAX_TICKS, FOCUS_TICK, POPOVER_LABEL, POPOVER_OPENS};
    use std::sync::atomic::Ordering;
    use tauri::{AppHandle, Manager, Runtime};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    fn set_attribute(hwnd: *mut core::ffi::c_void, attribute: i32, value: i32) -> bool {
        // SAFETY: `hwnd` is the live popover window; the value is a 4-byte
        // DWM enum read only during the call.
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute as u32,
                std::ptr::from_ref(&value).cast(),
                std::mem::size_of::<i32>() as u32,
            )
        };
        result >= 0
    }

    /// Rounded corners, and the Windows 11 flyout material (the DWM
    /// transient-window backdrop, Acrylic) where DWM accepts it: Windows 11
    /// 22H2 and later. Older builds refuse the attribute, and the page stays
    /// opaque: the blur-behind acrylic of Windows 10 lags and is not used.
    pub(super) fn apply_backdrop<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let _ = set_attribute(hwnd.0, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
        set_attribute(hwnd.0, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_TRANSIENTWINDOW)
    }

    /// Click-away close that does not depend on WebView2 focus events: once
    /// the popover has been the foreground window, any other foreground
    /// window (another app, the desktop, the taskbar) closes it. Ends with
    /// the popover, and after `FOCUS_MAX_TICKS` at the latest.
    pub(super) fn watch_foreground<R: Runtime>(app: &AppHandle<R>, opened: u64) {
        let mut was_foreground = false;
        for _ in 0..FOCUS_MAX_TICKS {
            std::thread::sleep(FOCUS_TICK);
            if POPOVER_OPENS.load(Ordering::SeqCst) != opened {
                return;
            }
            let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
                return;
            };
            let Ok(hwnd) = window.hwnd() else {
                return;
            };
            // SAFETY: no arguments; returns a handle or null.
            let foreground = unsafe { GetForegroundWindow() } == hwnd.0;
            if foreground {
                was_foreground = true;
            } else if was_foreground {
                close_popover(app);
                return;
            }
        }
        if POPOVER_OPENS.load(Ordering::SeqCst) == opened {
            close_popover(app);
        }
    }
}

/// macOS: logical size only; the popover hangs from the menu bar, so its
/// position never changes with height.
#[cfg(target_os = "macos")]
fn place<R: Runtime>(window: &tauri::WebviewWindow<R>, anchor: &Anchor, height: f64) {
    let ((w, h), _) = anchor.frame(height);
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
}

/// Windows: physical pixels on the item's monitor (tao applies them with
/// `SetWindowPos`). The second move settles a window that changed monitor, and
/// so DPI, on the first.
#[cfg(not(target_os = "macos"))]
fn place<R: Runtime>(window: &tauri::WebviewWindow<R>, anchor: &Anchor, height: f64) {
    let ((w, h), (x, y)) = anchor.frame(height);
    let at = tauri::PhysicalPosition::new(x as i32, y as i32);
    let _ = window.set_position(at);
    let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    let _ = window.set_position(at);
}

fn reveal<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    // tao tries SetForegroundWindow first; the tray click grants Mesa that
    // right, so its synthetic-Alt fallback runs only if Windows refuses.
    let _ = window.set_focus();
}

/// Fits the popover to its content height and shows it on the first fit.
fn fit_popover<R: Runtime>(app: &AppHandle<R>, height: f64) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    let anchor = popover_anchor().lock().ok().and_then(|slot| *slot);
    if let Some(anchor) = anchor {
        place(&window, &anchor, height);
    }
    if !window.is_visible().unwrap_or(true) {
        reveal(&window);
    }
}

/// Whether a window focus change closes the popover: its own blur, or any
/// other Mesa window gaining focus (a safety net where WebView2 reports no
/// blur, since tauri maps Windows focus from the webview's focus events).
pub(crate) fn focus_closes_popover(label: &str, focused: bool) -> bool {
    if label == POPOVER_LABEL {
        !focused
    } else {
        focused
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
        OPEN_ID => "open",
        "mesa-tray-search" => "search",
        "mesa-tray-task-list" => "tasks",
        SETTINGS_ID => "settings",
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
) -> Result<bool, String> {
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
    // The page lets a system backdrop show through only when it exists.
    Ok(POPOVER_BACKDROP.load(std::sync::atomic::Ordering::SeqCst))
}

/// Whether `tray::create` succeeded this run.
#[derive(Default)]
pub struct TrayPresence(std::sync::atomic::AtomicBool);

impl TrayPresence {
    pub fn mark_created(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Closing main may hide it only while the user can still see Mesa and reach
/// its Quit: macOS always (Dock and app menu), Windows behind a created tray
/// icon. Linux cannot tell whether its tray is shown (GNOME hides it without
/// AppIndicator), so there closing main quits.
pub(crate) fn close_may_hide(tray_created: bool, os: &str) -> bool {
    os == "macos" || (tray_created && os != "linux")
}

/// True when the main window should hide on close; false when it should
/// quit through the same save-guarded path as the tray Quit.
#[tauri::command]
pub fn main_close_hides<R: Runtime>(
    window: tauri::Window<R>,
    presence: tauri::State<'_, TrayPresence>,
) -> Result<bool, String> {
    crate::require_main(window.label())?;
    Ok(close_may_hide(
        presence.0.load(std::sync::atomic::Ordering::SeqCst),
        std::env::consts::OS,
    ))
}

/// Replaces the tray menu with the renderer's current snapshot. Replies
/// whether the menu shows that snapshot: Windows' short menu is fixed, so the
/// renderer stops sending (each reply repaints the WebView2 UI thread).
#[tauri::command]
pub fn tray_update<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    state: tauri::State<'_, TrayState>,
    snapshot: TraySnapshot,
) -> Result<bool, String> {
    crate::require_main(window.label())?;
    let style = menu_style(std::env::consts::OS);
    if style == MenuStyle::Short {
        return Ok(false);
    }
    let snapshot = bounded(snapshot);
    let menu = build_menu(&app, style, &snapshot).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    *state
        .0
        .lock()
        .map_err(|_| "tray state unavailable".to_string())? = snapshot;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn left_click_opens_the_popover_on_macos_and_windows_only() {
        // The Windows plain-menu bug: the menu opened on left click there.
        assert!(!menu_on_left_click("windows"));
        assert!(!menu_on_left_click("macos"));
        assert!(menu_on_left_click("linux"));
        assert!(menu_on_left_click("freebsd"));
    }

    #[test]
    fn popover_closes_on_its_blur_or_when_another_mesa_window_gains_focus() {
        assert!(focus_closes_popover(POPOVER_LABEL, false));
        assert!(!focus_closes_popover(POPOVER_LABEL, true));
        assert!(focus_closes_popover("main", true));
        assert!(!focus_closes_popover("main", false));
    }

    #[test]
    fn main_hides_on_close_only_behind_a_visible_tray() {
        assert!(close_may_hide(true, "windows"));
        assert!(!close_may_hide(false, "windows"));
        assert!(!close_may_hide(true, "linux"));
        assert!(close_may_hide(false, "macos"));
        let presence = TrayPresence::default();
        assert!(!presence.0.load(std::sync::atomic::Ordering::SeqCst));
        presence.mark_created();
        assert!(presence.0.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn labels_and_task_count_stay_bounded() {
        let long = "x".repeat(200);
        assert_eq!(clip(&long).chars().count(), MAX_LABEL_CHARS);
        assert!(clip(&long).ends_with('…'));
        assert_eq!(clip("  short  "), "short");
        // A literal `&` survives the menu's mnemonic parsing.
        assert_eq!(menu_label("R&D & Notes"), "R&&D && Notes");
        let edge = format!("{}&tail", "x".repeat(MAX_LABEL_CHARS - 2));
        assert_eq!(
            menu_label(&edge),
            format!("{}&&…", "x".repeat(MAX_LABEL_CHARS - 2))
        );
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

    fn snapshot_with_tasks() -> TraySnapshot {
        TraySnapshot {
            vault: Some("Frontier Vault".into()),
            save: "All changes saved".into(),
            tasks_summary: "279 open tasks".into(),
            tasks: (0..3)
                .map(|i| TrayTask {
                    label: format!("All {i} hashes processed"),
                    rel: "a.md".into(),
                    line: i,
                })
                .collect(),
            research: None,
            sync: "Sync: off".into(),
        }
    }

    fn ids(entries: &[Entry]) -> Vec<&str> {
        entries
            .iter()
            .map(|e| match e {
                Entry::Item { id, .. } => id.as_str(),
                Entry::Separator => "-",
            })
            .collect()
    }

    #[test]
    fn windows_right_click_menu_is_show_settings_quit_only() {
        assert_eq!(menu_style("windows"), MenuStyle::Short);
        let entries = menu_entries(MenuStyle::Short, &snapshot_with_tasks());
        assert_eq!(ids(&entries), [OPEN_ID, SETTINGS_ID, "-", QUIT_ID]);
        for entry in &entries {
            if let Entry::Item {
                label,
                enabled,
                accelerator,
                ..
            } = entry
            {
                // No disabled status rows, no task lines, no shortcut text.
                assert!(enabled, "{label}");
                assert_eq!(*accelerator, None, "{label}");
                assert!(!label.contains('○') && !label.contains("hashes"));
            }
        }
        let labels: Vec<_> = entries
            .iter()
            .filter_map(|e| match e {
                Entry::Item { label, .. } => Some(label.as_str()),
                Entry::Separator => None,
            })
            .collect();
        assert_eq!(labels, ["Show Mesa", "Settings", "Quit Mesa"]);
    }

    #[test]
    fn linux_and_macos_menus_keep_the_status_rows() {
        assert_eq!(menu_style("linux"), MenuStyle::Full);
        assert_eq!(menu_style("macos"), MenuStyle::Full);
        let entries = menu_entries(MenuStyle::Full, &snapshot_with_tasks());
        let ids = ids(&entries);
        assert_eq!(ids[0], "mesa-tray-vault");
        assert!(ids.contains(&"mesa-tray-task-2"));
        assert_eq!(ids.last(), Some(&QUIT_ID));
        assert!(entries.contains(&info("mesa-tray-save", "All changes saved")));
    }

    #[test]
    fn popover_reanchors_to_its_content_height() {
        use placement::{Edge, Rect};
        // Windows bottom taskbar at 150%: a shorter fit moves the top down so
        // the popover keeps its distance from the taskbar.
        let monitor = Rect::new(0.0, 0.0, 2880.0, 1620.0);
        let area = Rect::new(0.0, 0.0, 2880.0, 1548.0);
        let icon = Rect::new(2500.0, 1560.0, 48.0, 48.0);
        let anchor = Anchor::new(icon, monitor, area, 1.5);
        assert_eq!(anchor.edge, Edge::Bottom);
        assert_eq!(anchor.max_height, POPOVER_MAX_HEIGHT);
        // The bottom edge keeps both gaps: off the item and off the taskbar.
        let bottom =
            (1560.0 - POPOVER_SPACING.gap * 1.5).min(1548.0 - POPOVER_SPACING.bar_gap * 1.5);
        let (tall, tall_at) = anchor.frame(POPOVER_MAX_HEIGHT);
        let (short, short_at) = anchor.frame(320.0);
        assert_eq!(tall, (930.0, 840.0));
        assert_eq!(short, (930.0, 480.0));
        assert_eq!(tall_at.1 + tall.1, bottom.round());
        assert_eq!(short_at.1 + short.1, tall_at.1 + tall.1);
        // Heights stay between the bounds, and a bad scale falls back to 1.
        assert_eq!(anchor.frame(10.0).0 .1, (POPOVER_MIN_HEIGHT * 1.5).round());
        let odd = Anchor::new(icon, monitor, area, f64::NAN);
        assert_eq!(odd.scale, 1.0);
        // A short work area caps the height at the minimum, never below it.
        let low = Rect::new(0.0, 0.0, 2880.0, 200.0);
        let anchor = Anchor::new(Rect::new(2500.0, 210.0, 48.0, 48.0), monitor, low, 1.0);
        assert_eq!(anchor.max_height, POPOVER_MIN_HEIGHT);
    }
}
