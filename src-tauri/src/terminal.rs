use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "windows")]
use std::fs;

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    child: Box<dyn portable_pty::Child + Send>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    #[serde(rename = "sessionId")]
    session_id: String,
    stream: String,
    data: String,
}

static PI_BINARY: OnceLock<PathBuf> = OnceLock::new();

fn session_id() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("term-{n:x}")
}

#[cfg(target_os = "windows")]
fn executable_names(name: &str) -> Vec<OsString> {
    let raw = Path::new(name);
    if raw.extension().is_some() {
        return vec![OsString::from(name)];
    }

    let mut names = Vec::new();
    let pathext = env::var_os("PATHEXT")
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    for ext in pathext.split(';').filter(|ext| !ext.trim().is_empty()) {
        names.push(OsString::from(format!("{name}{ext}")));
    }
    names.push(OsString::from(name));
    names
}

#[cfg(target_os = "windows")]
fn executable_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    for executable in executable_names(name) {
        let candidate = dir.join(executable);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn executable_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if is_executable(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn command_on_path(name: &str) -> bool {
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            if executable_in_dir(&dir, name).is_some() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn comspec() -> String {
    env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(target_os = "windows")]
fn shell_command() -> CommandBuilder {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if command_on_path(candidate) {
            let mut cmd = CommandBuilder::new(candidate);
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            return cmd;
        }
    }
    let mut cmd = CommandBuilder::new(comspec());
    cmd.arg("/Q");
    cmd
}

fn terminal_command(program: Option<&str>) -> Result<(CommandBuilder, Vec<PathBuf>), String> {
    match program.map(str::trim).filter(|s| !s.is_empty()) {
        Some("pi") => {
            let pi = resolve_pi_binary()?;
            let path_prefixes = terminal_path_prefixes(&pi);
            let cmd = pi_command(&pi)?;
            Ok((cmd, path_prefixes))
        }
        Some(other) => Ok((CommandBuilder::new(other), Vec::new())),
        None => Ok((shell_command(), Vec::new())),
    }
}

#[cfg(not(target_os = "windows"))]
fn pi_command(pi: &Path) -> Result<CommandBuilder, String> {
    Ok(CommandBuilder::new(pi.to_string_lossy().to_string()))
}

#[cfg(target_os = "windows")]
fn pi_command(pi: &Path) -> Result<CommandBuilder, String> {
    if windows_launches_directly(pi) {
        return Ok(CommandBuilder::new(pi.to_string_lossy().to_string()));
    }

    if script_uses_node(pi) {
        return node_script_command(pi);
    }

    if let Some(ext) = pi
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
    {
        if matches!(ext.as_str(), "cmd" | "bat") {
            if let Some(script) = sibling_script_path(pi).filter(|script| script_uses_node(script)) {
                return node_script_command(&script);
            }

            let mut cmd = CommandBuilder::new(comspec());
            cmd.arg("/d");
            cmd.arg("/s");
            cmd.arg("/c");
            cmd.arg(pi.to_string_lossy().to_string());
            return Ok(cmd);
        }
    }

    Err(format!(
        "Resolved Pi path '{}' is not a native Windows executable, Node-backed script, or runnable .cmd/.bat shim. Point MESA_PI_BIN at the native Pi launcher or its adjacent Node script.",
        pi.to_string_lossy()
    ))
}

#[cfg(not(target_os = "windows"))]
fn shell_command() -> CommandBuilder {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-i");
    cmd
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn common_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(home) = home_dir() {
        dirs.push(home.join(".hermes/node/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".cargo/bin"));
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = env::var_os("APPDATA").map(PathBuf::from) {
            dirs.push(profile.join("npm"));
        }
        if let Some(home) = home_dir() {
            // run.cmd bootstraps Node/Git/Rust through Scoop; its shims live
            // here and are not always on the PATH Mesa inherits when launched
            // from the desktop instead of a terminal.
            dirs.push(home.join("scoop").join("shims"));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = env::var_os(key).map(PathBuf::from) {
                dirs.push(pf.join("nodejs"));
            }
        }
        if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Programs"));
            // Per-user Node.js installer target.
            dirs.push(local.join("Programs").join("nodejs"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
    }

    dirs
}

fn resolve_pi_binary() -> Result<PathBuf, String> {
    if let Some(cached) = PI_BINARY.get() {
        return Ok(cached.clone());
    }

    let resolved = find_pi_binary()?;
    let _ = PI_BINARY.set(resolved.clone());
    Ok(resolved)
}

fn find_pi_binary() -> Result<PathBuf, String> {
    let mut checked: Vec<PathBuf> = Vec::new();

    for key in ["MESA_PI_BIN", "PI_BIN"] {
        if let Some(raw) = env::var_os(key).filter(|value| !value.is_empty()) {
            let candidate = PathBuf::from(raw);
            checked.push(candidate.clone());
            if let Some(executable) = resolve_explicit_pi_candidate(&candidate) {
                return Ok(executable);
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let candidate = dir.join("pi");
            checked.push(candidate);
            if let Some(executable) = executable_in_dir(&dir, "pi") {
                return Ok(executable);
            }
        }
    }

    for dir in common_bin_dirs() {
        checked.push(dir.join("pi"));
        if let Some(executable) = executable_in_dir(&dir, "pi") {
            return Ok(executable);
        }
    }

    let checked = checked
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Unable to spawn pi because it was not found in PATH or Mesa's known install locations. Set MESA_PI_BIN to the Pi executable path, or install Pi in a standard bin directory. Checked: {checked}"
    ))
}

#[cfg(target_os = "windows")]
fn resolve_explicit_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    if candidate.extension().is_some() {
        return is_executable(candidate).then(|| candidate.to_path_buf());
    }

    for executable in executable_names(&candidate.to_string_lossy()) {
        let path = PathBuf::from(executable);
        if path != candidate && is_executable(&path) {
            return Some(path);
        }
    }

    is_executable(candidate).then(|| candidate.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn resolve_explicit_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    is_executable(candidate).then(|| candidate.to_path_buf())
}

fn terminal_path_prefixes(program: &Path) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();

    if let Some(parent) = program.parent() {
        prefixes.push(parent.to_path_buf());
    }

    for dir in common_bin_dirs() {
        prefixes.push(dir);
    }

    prefixes
}

#[cfg(target_os = "windows")]
fn windows_launches_directly(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
    {
        Some(ext) => matches!(ext.as_str(), "exe" | "com"),
        None => file_starts_with_mz(path),
    }
}

#[cfg(target_os = "windows")]
fn file_starts_with_mz(path: &Path) -> bool {
    fs::read(path)
        .map(|bytes| bytes.starts_with(b"MZ"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn script_uses_node(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return false;
    };
    text.lines()
        .next()
        .map(|line| line.starts_with("#!") && line.contains("node"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn sibling_script_path(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?;
    let sibling = path.with_file_name(stem);
    sibling.is_file().then_some(sibling)
}

#[cfg(target_os = "windows")]
fn node_script_command(script: &Path) -> Result<CommandBuilder, String> {
    let node = resolve_node_binary_for_script(script)?;
    let mut cmd = CommandBuilder::new(node.to_string_lossy().to_string());
    cmd.arg(script.to_string_lossy().to_string());
    Ok(cmd)
}

#[cfg(target_os = "windows")]
fn resolve_node_binary_for_script(script: &Path) -> Result<PathBuf, String> {
    if let Some(parent) = script.parent() {
        for candidate in [parent.join("node.exe"), parent.join("node")] {
            if windows_launches_directly(&candidate) {
                return Ok(candidate);
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            if let Some(executable) = executable_in_dir(&dir, "node") {
                return Ok(executable);
            }
        }
    }

    for dir in common_bin_dirs() {
        if let Some(executable) = executable_in_dir(&dir, "node") {
            return Ok(executable);
        }
    }

    Err(format!(
        "Pi resolved to the Node script '{}', but Mesa could not find node.exe to launch it. Install Node.js or point MESA_PI_BIN at a native Pi executable.",
        script.to_string_lossy()
    ))
}

fn merged_path(prefixes: &[PathBuf]) -> Option<OsString> {
    let mut paths: Vec<PathBuf> = Vec::new();

    for prefix in prefixes {
        if prefix.is_dir() && !paths.iter().any(|existing| existing == prefix) {
            paths.push(prefix.clone());
        }
    }

    if let Some(existing) = env::var_os("PATH") {
        for path in env::split_paths(&existing) {
            if !paths.iter().any(|candidate| candidate == &path) {
                paths.push(path);
            }
        }
    }

    if paths.is_empty() {
        return None;
    }

    env::join_paths(paths).ok()
}

fn spawn_reader<R>(mut reader: R, app: AppHandle, id: String, stream: &'static str)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        "terminal://output",
                        TerminalOutput {
                            session_id: id.clone(),
                            stream: stream.to_string(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<TerminalState>,
    cwd: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    envs: Option<HashMap<String, String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    let id = session_id();
    let (mut cmd, path_prefixes) = terminal_command(program.as_deref())?;
    if let Some(dir) = cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.cwd(dir);
    }
    if let Some(args) = args {
        for arg in args {
            cmd.arg(arg);
        }
    }
    cmd.env("MESA_TERMINAL", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "Mesa");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = merged_path(&path_prefixes) {
        cmd.env("PATH", path.to_string_lossy().to_string());
    }
    if let Some(envs) = envs {
        for (key, value) in envs {
            if key.starts_with("MESA_") {
                cmd.env(key, value);
            }
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24).clamp(2, 500),
            cols: cols.unwrap_or(80).clamp(2, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    drop(pair.slave);

    spawn_reader(reader, app, id.clone(), "stdout");

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        id.clone(),
        TerminalSession {
            child,
            master: pair.master,
            writer,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(2, 500),
            cols: cols.clamp(2, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_write(
    state: State<TerminalState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .writer
        .write_all(input.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_stop(state: State<TerminalState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}
