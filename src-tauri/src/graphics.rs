//! Hardware acceleration: a launch-time preference that must be read before
//! the first webview exists. Tauri creates the config windows before the
//! `setup` hook (tauri 2.12.1 `app.rs` `fn setup`), so `apply_at_launch` runs
//! first in `run()` and only sets process environment the engines read when
//! they start:
//!
//! - Windows: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` gains `--disable-gpu`.
//!   WebView2 appends this variable to the options wry passes, so wry's own
//!   arguments stay. Every Mesa webview shares one browser process, whose
//!   options must match, so the variable covers all windows alike.
//! - Linux: `WEBKIT_DISABLE_COMPOSITING_MODE=1` (documented WebKitGTK switch)
//!   and `WEBKIT_DISABLE_DMABUF_RENDERER=1` (the GPU buffer renderer of
//!   WebKitGTK 2.42+). A value the user already set is left alone.
//! - macOS: WKWebView has no public switch (`WKPreferences.h` in the macOS
//!   SDK lists none); WebKit always composites with Core Animation / Metal.
//!   Nothing is set and the preference cannot be changed there.
//!
//! The preference lives in `graphics.json` in Tauri's app config folder
//! (`dirs::config_dir()/<identifier>`, the same path as `app_config_dir`).
//! A missing, oversized or unreadable file means "on".

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Bundle identifier from `tauri.conf.json` (a test keeps them equal).
const APP_IDENTIFIER: &str = "dev.xo.mesa";
const PREFS_FILE: &str = "graphics.json";
const PREFS_LIMIT: u64 = 4 * 1024;

pub(crate) const WEBVIEW2_ARGS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
pub(crate) const DISABLE_GPU: &str = "--disable-gpu";
pub(crate) const WEBKIT_COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
pub(crate) const WEBKIT_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Whether this platform lets Mesa turn hardware acceleration off.
pub(crate) const CONTROLLABLE: bool = cfg!(any(windows, target_os = "linux"));

/// What this process applied at launch.
static ACTIVE: AtomicBool = AtomicBool::new(true);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Engine {
    WebView2,
    WebKitGtk,
    WkWebView,
}

impl Engine {
    const fn current() -> Self {
        if cfg!(windows) {
            Self::WebView2
        } else if cfg!(target_os = "linux") {
            Self::WebKitGtk
        } else {
            Self::WkWebView
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    hardware_acceleration: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsState {
    /// Saved preference, used from the next launch.
    saved: bool,
    /// What this launch applied.
    active: bool,
    /// False where the platform offers no switch (macOS).
    controllable: bool,
}

/// Environment to set before the first webview. `existing` reads the current
/// value of a variable. Acceleration on sets nothing.
pub(crate) fn launch_env(
    enabled: bool,
    engine: Engine,
    existing: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, String)> {
    if enabled {
        return Vec::new();
    }
    match engine {
        Engine::WebView2 => match existing(WEBVIEW2_ARGS) {
            Some(args) if args.split_whitespace().any(|a| a == DISABLE_GPU) => Vec::new(),
            Some(args) if !args.trim().is_empty() => {
                vec![(WEBVIEW2_ARGS, format!("{} {DISABLE_GPU}", args.trim()))]
            }
            _ => vec![(WEBVIEW2_ARGS, DISABLE_GPU.to_string())],
        },
        Engine::WebKitGtk => [WEBKIT_COMPOSITING, WEBKIT_DMABUF]
            .into_iter()
            .filter(|name| existing(name).is_none())
            .map(|name| (name, "1".to_string()))
            .collect(),
        Engine::WkWebView => Vec::new(),
    }
}

fn prefs_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(APP_IDENTIFIER).join(PREFS_FILE))
}

/// Saved preference; anything but a readable, well-formed file is "on".
fn read_saved(path: &Path) -> bool {
    use std::io::Read;
    let Ok(file) = crate::sync_core::open_file_no_follow(path) else {
        return true;
    };
    let mut bytes = Vec::new();
    if file.take(PREFS_LIMIT + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 > PREFS_LIMIT
    {
        return true;
    }
    serde_json::from_slice::<Stored>(&bytes).map_or(true, |s| s.hardware_acceleration)
}

fn write_saved(path: &Path, enabled: bool) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or("Cannot locate Mesa's settings folder")?;
    std::fs::create_dir_all(dir).map_err(|_| "Cannot create Mesa's settings folder")?;
    let bytes = serde_json::to_vec(&Stored {
        hardware_acceleration: enabled,
    })
    .map_err(|_| "Cannot encode the graphics preference")?;
    crate::vaultwrite::write_atomic(path, &bytes, &crate::vaultwrite::ExpectedCurrent::Any)
}

/// Read the saved preference and set the engine environment. Call first in
/// `run()`, before any webview and, on Linux, before any other thread.
pub(crate) fn apply_at_launch() {
    let enabled = !CONTROLLABLE || prefs_path().is_none_or(|path| read_saved(&path));
    ACTIVE.store(enabled, Ordering::Relaxed);
    for (name, value) in launch_env(enabled, Engine::current(), |n| std::env::var(n).ok()) {
        std::env::set_var(name, value);
    }
}

fn state(path: &Path) -> GraphicsState {
    GraphicsState {
        saved: !CONTROLLABLE || read_saved(path),
        active: ACTIVE.load(Ordering::Relaxed),
        controllable: CONTROLLABLE,
    }
}

/// Main-only. Without `enabled`, reports; with it, saves for the next launch.
#[tauri::command(async)]
pub fn graphics_acceleration(
    window: tauri::Window,
    enabled: Option<bool>,
) -> Result<GraphicsState, String> {
    crate::require_main(window.label())?;
    let path = prefs_path().ok_or("Cannot locate Mesa's settings folder")?;
    if let Some(enabled) = enabled {
        if !CONTROLLABLE {
            return Err("macOS gives apps no switch for hardware acceleration".into());
        }
        write_saved(&path, enabled)?;
    }
    Ok(state(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &str) -> Option<String> {
        None
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mesa-graphics-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn acceleration_on_sets_nothing_on_any_engine() {
        for engine in [Engine::WebView2, Engine::WebKitGtk, Engine::WkWebView] {
            assert!(launch_env(true, engine, none).is_empty(), "{engine:?}");
        }
    }

    #[test]
    fn windows_off_adds_disable_gpu_and_keeps_user_arguments() {
        assert_eq!(
            launch_env(false, Engine::WebView2, none),
            vec![(WEBVIEW2_ARGS, "--disable-gpu".to_string())]
        );
        let user = |_: &str| Some(" --lang=de ".to_string());
        assert_eq!(
            launch_env(false, Engine::WebView2, user),
            vec![(WEBVIEW2_ARGS, "--lang=de --disable-gpu".to_string())]
        );
        let already = |_: &str| Some("--lang=de --disable-gpu".to_string());
        assert!(launch_env(false, Engine::WebView2, already).is_empty());
    }

    #[test]
    fn linux_off_disables_compositing_and_dmabuf_unless_user_set_them() {
        assert_eq!(
            launch_env(false, Engine::WebKitGtk, none),
            vec![
                (WEBKIT_COMPOSITING, "1".to_string()),
                (WEBKIT_DMABUF, "1".to_string())
            ]
        );
        let user = |n: &str| (n == WEBKIT_COMPOSITING).then(|| "0".to_string());
        assert_eq!(
            launch_env(false, Engine::WebKitGtk, user),
            vec![(WEBKIT_DMABUF, "1".to_string())]
        );
    }

    #[test]
    fn macos_has_no_switch() {
        assert!(launch_env(false, Engine::WkWebView, none).is_empty());
        assert_eq!(CONTROLLABLE, !cfg!(target_os = "macos"));
    }

    #[test]
    fn preference_defaults_on_and_round_trips() {
        let dir = temp("roundtrip");
        let path = dir.join("nested").join(PREFS_FILE);
        assert!(read_saved(&path), "missing file means on");
        write_saved(&path, false).unwrap();
        assert!(!read_saved(&path));
        write_saved(&path, true).unwrap();
        assert!(read_saved(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_or_oversized_preference_means_on() {
        let dir = temp("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PREFS_FILE);
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_saved(&path));
        let mut big = br#"{"hardwareAcceleration":false}"#.to_vec();
        big.resize(PREFS_LIMIT as usize + 1, b' ');
        std::fs::write(&path, &big).unwrap();
        assert!(read_saved(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identifier_matches_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }
}
