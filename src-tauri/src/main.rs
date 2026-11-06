// Prevents an extra console window on Windows in release. DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(windows, test))]
mod applog;

fn main() {
    // Without a console, stderr goes to a bounded log file in app data.
    #[cfg(windows)]
    applog::capture_stderr();
    mesa_lib::run();
}
