use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
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
    history: Arc<Mutex<TerminalHistory>>,
    /// The Mesa window currently responsible for PTY dimensions. Output/input
    /// remain app-global, but only the focused/adopting renderer may resize:
    /// two xterms fighting over one PTY width corrupt TUI cursor arithmetic.
    resize_owner: String,
    rows: u16,
    cols: u16,
}

const TERMINAL_HISTORY_MAX_BYTES: usize = 4 * 1024 * 1024;
const TERMINAL_RESIZE_HISTORY_COST: usize = 4;

#[derive(Default)]
struct TerminalHistory {
    entries: VecDeque<TerminalHistoryEntry>,
    bytes: usize,
    seq: u64,
}

enum TerminalHistoryEntry {
    Output(String),
    Resize { rows: u16, cols: u16 },
}

impl TerminalHistory {
    fn trim(&mut self) {
        while self.bytes > TERMINAL_HISTORY_MAX_BYTES && self.entries.len() > 1 {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes = self.bytes.saturating_sub(match removed {
                    TerminalHistoryEntry::Output(data) => data.len(),
                    TerminalHistoryEntry::Resize { .. } => TERMINAL_RESIZE_HISTORY_COST,
                });
            }
        }
    }

    fn push_output(&mut self, data: String) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.bytes += data.len();
        self.entries.push_back(TerminalHistoryEntry::Output(data));
        self.trim();
        self.seq
    }

    fn push_resize(&mut self, rows: u16, cols: u16) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.bytes += TERMINAL_RESIZE_HISTORY_COST;
        self.entries
            .push_back(TerminalHistoryEntry::Resize { rows, cols });
        self.trim();
        self.seq
    }

    fn snapshot(&self) -> String {
        self.entries
            .iter()
            .filter_map(|entry| match entry {
                TerminalHistoryEntry::Output(data) => Some(data.as_str()),
                TerminalHistoryEntry::Resize { .. } => None,
            })
            .collect()
    }

    fn replay(&self) -> Vec<TerminalReplayEvent> {
        self.entries
            .iter()
            .map(|entry| match entry {
                TerminalHistoryEntry::Output(data) => TerminalReplayEvent {
                    kind: "output",
                    data: Some(data.clone()),
                    rows: None,
                    cols: None,
                },
                TerminalHistoryEntry::Resize { rows, cols } => TerminalReplayEvent {
                    kind: "resize",
                    data: None,
                    rows: Some(*rows),
                    cols: Some(*cols),
                },
            })
            .collect()
    }
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    #[serde(rename = "sessionId")]
    session_id: String,
    stream: String,
    data: String,
    seq: u64,
}

#[derive(Serialize)]
pub struct TerminalSnapshot {
    data: String,
    seq: u64,
    events: Vec<TerminalReplayEvent>,
}

#[derive(Serialize)]
pub struct TerminalReplayEvent {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cols: Option<u16>,
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
            if let Some(script) = sibling_script_path(pi).filter(|script| script_uses_node(script))
            {
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

/// Incremental UTF-8 decoder for one PTY byte stream.
///
/// **Double-render contract.** A PTY read returns whatever bytes were available
/// when the kernel filled the buffer, so a multi-byte character is regularly
/// split across two reads. Decoding each read independently with
/// `String::from_utf8_lossy` turned every such split into replacement
/// characters — and a 1-column character becomes 2-3 U+FFFD columns, which
/// silently widens the line. The emulator then soft-wraps a row earlier than Pi
/// does, Pi's cursor-up redraw arithmetic lands one row low, and the previous
/// render is stranded above the new one. That is the "Pi renders text twice"
/// bug, and it fires wherever Pi's TUI uses box drawing, spinners, em dashes,
/// or curly quotes — i.e. constantly.
///
/// Holding an incomplete trailing sequence back until the next read keeps the
/// emitted text byte-exact. The carry is bounded by UTF-8 itself: a truncated
/// sequence is at most 3 bytes.
#[derive(Default)]
struct Utf8Stream {
    carry: Vec<u8>,
}

impl Utf8Stream {
    /// Decode `chunk`, prefixed by any tail held back from the previous read.
    /// Genuinely invalid bytes still become U+FFFD, matching `from_utf8_lossy`;
    /// only *truncated* sequences are deferred.
    fn push(&mut self, chunk: &[u8]) -> String {
        let joined: Vec<u8>;
        let mut rest: &[u8] = if self.carry.is_empty() {
            chunk
        } else {
            joined = self
                .carry
                .drain(..)
                .chain(chunk.iter().copied())
                .collect::<Vec<u8>>();
            &joined
        };

        let mut out = String::with_capacity(chunk.len());
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    return out;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    // `valid_up_to` is guaranteed to sit on a char boundary.
                    if let Ok(text) = std::str::from_utf8(&rest[..valid]) {
                        out.push_str(text);
                    }
                    match err.error_len() {
                        // Truncated tail — the rest of the character is in the
                        // next read. Hold it back rather than mangling it.
                        None => {
                            self.carry.extend_from_slice(&rest[valid..]);
                            return out;
                        }
                        // Not UTF-8 at all; emit U+FFFD and keep decoding.
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[valid + len..];
                        }
                    }
                }
            }
        }
    }

    /// Flush a tail left incomplete by EOF. Nothing more is coming, so the
    /// truncated bytes can only be rendered as U+FFFD.
    fn flush(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        self.carry.clear();
        char::REPLACEMENT_CHARACTER.to_string()
    }
}

fn spawn_reader<R>(
    mut reader: R,
    app: AppHandle,
    id: String,
    stream: &'static str,
    history: Arc<Mutex<TerminalHistory>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut decoder = Utf8Stream::default();
        let emit = |data: String| {
            if data.is_empty() {
                return;
            }
            let seq = history
                .lock()
                .map(|mut history| history.push_output(data.clone()))
                .unwrap_or(0);
            let _ = app.emit(
                "terminal://output",
                TerminalOutput {
                    session_id: id.clone(),
                    stream: stream.to_string(),
                    data,
                    seq,
                },
            );
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => emit(decoder.push(&buf[..n])),
                Err(_) => break,
            }
        }
        emit(decoder.flush());
    });
}

// The parameter list is the IPC contract with the frontend's `terminal_start`
// invoke — every argument arrives as a named field, so a params struct would
// only obscure the wire shape.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn terminal_start(
    window: tauri::Window,
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

    let rows = rows.unwrap_or(24).clamp(2, 500);
    let cols = cols.unwrap_or(80).clamp(2, 500);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut initial_history = TerminalHistory::default();
    initial_history.push_resize(rows, cols);
    let history = Arc::new(Mutex::new(initial_history));
    spawn_reader(reader, app, id.clone(), "stdout", Arc::clone(&history));

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        id.clone(),
        TerminalSession {
            child,
            master: pair.master,
            writer,
            history,
            resize_owner: window.label().to_string(),
            rows,
            cols,
        },
    );
    Ok(id)
}

fn resize_master(session: &mut TerminalSession, rows: u16, cols: u16) -> Result<(), String> {
    let rows = rows.clamp(2, 500);
    let cols = cols.clamp(2, 500);
    if session.rows == rows && session.cols == cols {
        return Ok(());
    }
    // Keep the history lock across the native resize so any TUI repaint bytes
    // the reader sees afterwards cannot enter history before this resize
    // marker. A detached xterm replays the exact historical grid timeline.
    let mut history = session.history.lock().map_err(|e| e.to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    history.push_resize(rows, cols);
    session.rows = rows;
    session.cols = cols;
    Ok(())
}

/// Adopt resize ownership for an existing shared PTY. A detached Pi webview
/// calls this before replaying output; focus changes call it again when the
/// session docks back. The mutex makes owner change + resize one transaction,
/// so an old renderer cannot land a stale size after the handoff.
#[tauri::command]
pub fn terminal_attach(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    resize_master(session, rows, cols)?;
    session.resize_owner = window.label().to_string();
    Ok(())
}

#[tauri::command]
pub fn terminal_snapshot(
    state: State<TerminalState>,
    session_id: String,
) -> Result<TerminalSnapshot, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    let history = session.history.lock().map_err(|e| e.to_string())?;
    Ok(TerminalSnapshot {
        data: history.snapshot(),
        seq: history.seq,
        events: history.replay(),
    })
}

#[tauri::command]
pub fn terminal_resize(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<bool, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    if session.resize_owner != window.label() {
        return Ok(false);
    }
    resize_master(session, rows, cols)?;
    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_history_preserves_order_and_sequence() {
        let mut history = TerminalHistory::default();
        assert_eq!(history.push_resize(24, 80), 1);
        assert_eq!(history.push_output("one".into()), 2);
        assert_eq!(history.push_output(" two".into()), 3);
        assert_eq!(history.snapshot(), "one two");
        assert_eq!(history.seq, 3);
        let replay = history.replay();
        assert_eq!(replay.len(), 3);
        assert_eq!(replay[0].kind, "resize");
        assert_eq!(replay[0].rows, Some(24));
        assert_eq!(replay[1].kind, "output");
        assert_eq!(replay[1].data.as_deref(), Some("one"));
    }

    #[test]
    fn terminal_history_is_bounded_without_dropping_the_latest_chunk() {
        let mut history = TerminalHistory::default();
        history.push_output("a".repeat(TERMINAL_HISTORY_MAX_BYTES));
        history.push_output("latest".into());
        assert_eq!(history.snapshot(), "latest");
    }

    /// The double-render regression: splitting a multi-byte character across
    /// two PTY reads must not change the decoded text by a single column.
    #[test]
    fn split_multibyte_characters_survive_a_read_boundary() {
        // Box drawing, spinner, em dash, curly quotes — Pi's TUI vocabulary.
        let source = "─┤⋮├─ Mesa — “Local NSFW” ─┤⋮├─";
        let bytes = source.as_bytes();

        for split in 0..bytes.len() {
            let mut decoder = Utf8Stream::default();
            let mut decoded = decoder.push(&bytes[..split]);
            decoded.push_str(&decoder.push(&bytes[split..]));
            decoded.push_str(&decoder.flush());
            assert_eq!(decoded, source, "split at byte {split}");
        }
    }

    #[test]
    fn every_read_boundary_of_a_stream_is_lossless() {
        let source = "⋮ Working…\r\n─────────\r\n17.8%/64k (auto)\r\n".repeat(4);
        let bytes = source.as_bytes();

        for chunk in 1..=bytes.len().min(24) {
            let mut decoder = Utf8Stream::default();
            let mut decoded = String::new();
            for window in bytes.chunks(chunk) {
                decoded.push_str(&decoder.push(window));
            }
            decoded.push_str(&decoder.flush());
            assert_eq!(decoded, source, "chunk size {chunk}");
        }
    }

    #[test]
    fn invalid_bytes_still_become_replacement_characters() {
        let mut decoder = Utf8Stream::default();
        // 0xFF is never valid UTF-8 and is not a truncated prefix, so it must
        // be replaced immediately rather than held back forever.
        assert_eq!(decoder.push(b"a\xffb"), "a\u{fffd}b");
        assert!(decoder.carry.is_empty());
    }

    #[test]
    fn a_truncated_tail_is_held_back_not_mangled() {
        let mut decoder = Utf8Stream::default();
        // First two bytes of "─" (E2 94 80).
        assert_eq!(decoder.push(b"ok\xe2\x94"), "ok");
        assert_eq!(decoder.carry, vec![0xe2, 0x94]);
        assert_eq!(decoder.push(b"\x80!"), "─!");
        assert!(decoder.carry.is_empty());
    }

    #[test]
    fn eof_flushes_a_truncated_tail_once() {
        let mut decoder = Utf8Stream::default();
        assert_eq!(decoder.push(b"\xe2\x94"), "");
        assert_eq!(decoder.flush(), "\u{fffd}");
        assert_eq!(decoder.flush(), "");
    }

    #[test]
    fn resize_markers_do_not_consume_output_history_budget() {
        let mut history = TerminalHistory::default();
        history.push_resize(24, 80);
        history.push_resize(30, 100);
        history.push_output("visible".into());
        assert_eq!(history.snapshot(), "visible");
        assert_eq!(history.replay().len(), 3);
    }
}
