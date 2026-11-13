use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Condvar, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

#[path = "pi_launch.rs"]
mod pi_launch;
#[path = "terminal_stream.rs"]
mod stream;
use pi_launch::*;
use stream::*;

#[cfg(target_os = "windows")]
use std::fs;

#[cfg(target_os = "windows")]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a Windows HANDLE is an opaque, process-owned kernel reference. Moving this
// sole owner between threads is supported by the Win32 API; `Drop` closes it
// exactly once, after the terminal session leaves the mutex-protected map.
#[cfg(target_os = "windows")]
unsafe impl Send for WindowsJob {}

/// Assign the PTY leader to a kill-on-close job. Windows automatically places
/// descendants (including a shell wrapper's Node/Pi grandchild) in that job,
/// so closing Mesa cannot leave a process holding a vault or build directory.
/// The assignment happens just after `CreateProcessW` returns: portable-pty
/// owns that call and its creation flags, so `CREATE_SUSPENDED` or a
/// `PROC_THREAD_ATTRIBUTE_JOB_LIST` cannot be passed. A child that spawns a
/// process within that window (before Node has even loaded) would escape.
#[cfg(target_os = "windows")]
fn own_windows_process_tree(pid: u32) -> Result<WindowsJob, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    // SAFETY: null security attributes and a null name are documented inputs
    // that create an unnamed job with the default descriptor.
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(format!(
            "CreateJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: the struct holds only integers and nested integer structs, for
    // which all-zero bytes are a valid value.
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `job` is the live handle created above; `info` is the struct the
    // extended-limit class names, and the length passed is its exact size.
    let set = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut _,
            std::mem::size_of_val(&info) as u32,
        )
    };
    if set == 0 {
        // SAFETY: `job` is open, owned only here and closed once on this path.
        unsafe {
            CloseHandle(job);
        }
        return Err(format!(
            "SetInformationJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: plain value arguments; a stale or foreign `pid` makes the call
    // fail with a null handle, which is checked next.
    let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        // SAFETY: `job` is open, owned only here and closed once on this path.
        unsafe {
            CloseHandle(job);
        }
        return Err(format!(
            "OpenProcess failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: both handles are open and were checked for null above.
    let assigned = unsafe { AssignProcessToJobObject(job, process) };
    // SAFETY: `process` is open, used by no one else and closed exactly once.
    unsafe {
        CloseHandle(process);
    }
    if assigned == 0 {
        // SAFETY: `job` is open, owned only here and closed once on this path.
        unsafe {
            CloseHandle(job);
        }
        return Err(format!(
            "AssignProcessToJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(WindowsJob(job))
}

#[cfg(target_os = "windows")]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        // SAFETY: `WindowsJob` is only built from a successful job handle it
        // owns alone, and `drop` runs once, so the handle is closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Clone)]
struct SessionAccess {
    labels: HashSet<String>,
    handoff: Option<(String, String, Instant)>,
}
impl SessionAccess {
    fn new(owner: &str) -> Self {
        Self {
            labels: HashSet::from(["main".into(), owner.into()]),
            handoff: None,
        }
    }
    fn require(&self, label: &str) -> Result<(), String> {
        if self.labels.contains(label) {
            Ok(())
        } else {
            Err("Terminal session is owned by another window".into())
        }
    }
    /// Research viewers may snapshot output without owning or driving the session.
    fn require_reader(&self, label: &str) -> Result<(), String> {
        if self.labels.contains(label) || label.starts_with("research-") {
            Ok(())
        } else {
            Err("Terminal session is owned by another window".into())
        }
    }
    fn prepare(&mut self, caller: &str, target: &str) -> Result<String, String> {
        crate::require_main(caller)?;
        self.require(caller)?;
        if !target.starts_with("agent-") || target.len() > 128 {
            return Err("Invalid Pi handoff target".into());
        }
        let token = session_id()?;
        self.handoff = Some((target.into(), token.clone(), Instant::now()));
        Ok(token)
    }
    fn revoke(&mut self, label: &str) {
        self.labels.remove(label);
        if self
            .handoff
            .as_ref()
            .is_some_and(|(target, _, _)| target == label)
        {
            self.handoff = None;
        }
    }
    fn attach(&mut self, label: &str, token: Option<&str>) -> Result<(), String> {
        if self.labels.contains(label) {
            return Ok(());
        }
        let valid = self
            .handoff
            .as_ref()
            .is_some_and(|(target, expected, created)| {
                target == label
                    && token == Some(expected.as_str())
                    && created.elapsed() <= Duration::from_secs(30)
            });
        if !valid {
            return Err("Pi handoff is missing, expired, or belongs to another window".into());
        }
        self.handoff = None;
        self.labels.retain(|label| label == "main");
        self.labels.insert(label.into());
        Ok(())
    }
}

struct TerminalSession {
    child: Box<dyn portable_pty::Child + Send>,
    master: Box<dyn MasterPty + Send>,
    /// Ordered input queue drained by one writer thread, so a Pi that stops
    /// reading stdin can never block an IPC thread or the sessions lock.
    input: mpsc::SyncSender<Vec<u8>>,
    stream: Arc<TerminalStream>,
    /// Only an authorized focused/adopting renderer may resize the shared PTY.
    resize_owner: String,
    access: SessionAccess,
    subscribers: HashMap<String, (String, tauri::ipc::Channel<serde_json::Value>)>,
    rows: u16,
    cols: u16,
    /// Dropping this handle kills the whole Windows ConPTY process tree.
    #[cfg(target_os = "windows")]
    _job: WindowsJob,
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

fn session_id() -> Result<String, String> {
    let id =
        crate::hex::random_hex::<16>().ok_or("Could not generate a terminal session identifier")?;
    Ok(format!("term-{id}"))
}

/// Prompts only when no saved decision exists. A failed save still allows this
/// launch; Mesa asks again next time. Denial is never recorded.
fn approve_external_process(
    gate: &Mutex<()>,
    remembered: impl FnOnce() -> bool,
    confirm: impl FnOnce() -> bool,
    remember: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _gate = gate
        .lock()
        .map_err(|_| "Pi permission state is unavailable")?;
    if remembered() {
        return Ok(());
    }
    if !confirm() {
        return Err("Pi launch cancelled: external process access was not approved".into());
    }
    if let Err(error) = remember() {
        eprintln!("Mesa could not save the Pi permission: {error}");
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    #[serde(rename = "sessionId")]
    session_id: String,
    code: Option<u32>,
}

/// Remove a session whose PTY reached EOF and reap its child. Returns the exit
/// code when this call retired the session; `None` when `terminal_stop` (or an
/// earlier call) already did, so exactly one exit is ever reported.
fn retire_exited_session(
    sessions: &Mutex<HashMap<String, TerminalSession>>,
    session_id: &str,
) -> Option<Option<u32>> {
    let session = sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(session_id)?;
    let mut child = session.child;
    Some(child.wait().ok().map(|status| status.exit_code()))
}

/// Emit coalesced output batches for one PTY session, then report its exit.
fn spawn_flusher(stream: Arc<TerminalStream>, app: AppHandle, id: String, name: &'static str) {
    let spawned = thread::Builder::new()
        .name("mesa-terminal-flusher".to_string())
        .spawn(move || loop {
            let batch = next_output_batch(&stream);
            if batch.is_empty() {
                // All output is delivered; only now announce the exit so the
                // webview never sees it ahead of the final bytes.
                let state = app.state::<TerminalState>();
                let labels = session_recipients(&app, &id);
                if let Some(code) = retire_exited_session(&state.sessions, &id) {
                    emit_terminal(
                        &app,
                        &labels,
                        "terminal://exit",
                        TerminalExit {
                            session_id: id.clone(),
                            code,
                        },
                    );
                }
                return;
            }
            for (data, seq) in batch {
                // Emission stays on this one thread, so `seq` reaches the
                // webview in the order the bytes left the PTY.
                emit_terminal(
                    &app,
                    &session_recipients(&app, &id),
                    "terminal://output",
                    TerminalOutput {
                        session_id: id.clone(),
                        stream: name.to_string(),
                        data,
                        seq,
                    },
                );
            }
        });
    if let Err(error) = spawned {
        eprintln!("Mesa could not start the Pi output thread: {error}");
    }
}

fn apply_frontend_env(cmd: &mut CommandBuilder, envs: &HashMap<String, String>) {
    for (key, value) in envs {
        if matches!(
            key.as_str(),
            "MESA_VAULT_NAME"
                | "MESA_VAULT_PATH"
                | "MESA_ACTIVE_PATH"
                | "MESA_ACTIVE_FILE_PATH"
                | "MESA_OPEN_PATHS"
                | "MESA_OPEN_FILE_PATHS"
                | "MESA_CENTER_VIEW"
                | "MESA_RIGHT_VIEWS"
                | "MESA_CONTEXT"
                | "MESA_DEEP_RESEARCH"
                | "MESA_DEEP_RESEARCH_RUN_ID"
        ) {
            cmd.env(key, value);
        }
    }
}

// The parameter list is the IPC contract with the frontend's `terminal_start`
// invoke — every argument arrives as a named field, so a params struct would
// only obscure the wire shape.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn terminal_start(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: Option<String>,
    program: Option<String>,
    envs: Option<HashMap<String, String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    crate::require_agent_surface(window.label())?;
    let requested = cwd.as_deref().ok_or("Pi needs an approved vault folder")?;
    let root = crate::vaultscope::require_approved(&app, requested)?;
    let (mut cmd, program_dir) = terminal_command(program.as_deref())?;
    let cwd = launch_cwd(requested, &root, cfg!(windows));
    if launches_through_cmd(&cmd) && !cmd_accepts_cwd(&cwd) {
        return Err("Pi's launcher runs through cmd.exe, which cannot start in a folder opened by its network (UNC) path. Open the vault through a mapped drive letter, or set MESA_PI_BIN to Pi's Node script.".into());
    }
    static PROCESS_GATE: Mutex<()> = Mutex::new(());
    let approved_root = root.clone();
    let display_root = cwd.clone();
    let dialog_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        approve_external_process(
            &PROCESS_GATE,
            || crate::vaultscope::pi_process_allowed(&dialog_app, &approved_root).unwrap_or(false),
            || dialog_app.dialog().message(
                format!("Vault: {}\n\nPi runs with your normal OS permissions. It can read or change files outside this vault, run commands, and use the network. Pi edits bypass Mesa's verified saves and recovery. Untrusted notes, webpages, and extensions can influence its actions. Allow this trusted external process for this vault?\n\nMesa remembers this choice. To remove it, remove this vault from the recent list in the vault menu.", display_root.display())
            ).title("Allow Pi external process access?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Allow Pi".into(), "Cancel".into()))
                .blocking_show(),
            || crate::vaultscope::remember_pi_process(&dialog_app, &approved_root),
        )
    }).await.map_err(|_| "Pi permission dialog failed")??;
    let id = session_id()?;
    cmd.cwd(cwd);
    cmd.env("MESA_TERMINAL", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "Mesa");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = merged_path(
        program_dir.as_deref(),
        env::var_os("PATH"),
        &common_bin_dirs(),
    ) {
        cmd.env("PATH", path.to_string_lossy().to_string());
    }
    let envs = envs.unwrap_or_default();
    let research = envs
        .get("MESA_DEEP_RESEARCH_RUN_ID")
        .filter(|id| !id.trim().is_empty());
    apply_frontend_env(&mut cmd, &envs);
    // Bridge secrets travel directly to the approved process, never to a renderer.
    if let Ok(activity) = crate::activity::start_native(app.clone()) {
        for path in [
            &activity.extension_path,
            &activity.goal_extension_path,
            &activity.context_extension_path,
            &activity.browser_extension_path,
        ] {
            cmd.arg("--extension");
            cmd.arg(path);
        }
        cmd.env("MESA_ACTIVITY_PORT", activity.port.to_string());
        cmd.env("MESA_ACTIVITY_TOKEN", &activity.token);
        if research.is_some() {
            cmd.arg("--extension");
            cmd.arg(&activity.deep_research_extension_path);
            cmd.env("MESA_DEEP_RESEARCH", "1");
        }
    } else if research.is_some() {
        return Err("Deep Research bridge is unavailable; Pi was not started".into());
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
    #[allow(unused_mut)] // Windows kills the child if Job Object setup fails.
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let job = match child
        .process_id()
        .ok_or_else(|| "PTY child has no Windows process id".to_string())
        .and_then(own_windows_process_tree)
    {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let input = spawn_input_writer(pair.master.take_writer().map_err(|e| e.to_string())?);
    drop(pair.slave);

    let mut initial_history = TerminalHistory::default();
    initial_history.push_resize(rows, cols);
    let stream = Arc::new(TerminalStream::new(initial_history));
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            TerminalSession {
                child,
                master: pair.master,
                input,
                stream: Arc::clone(&stream),
                resize_owner: window.label().to_string(),
                access: SessionAccess::new(window.label()),
                subscribers: HashMap::new(),
                rows,
                cols,
                #[cfg(target_os = "windows")]
                _job: job,
            },
        );
    }
    // Start the pump only after the session is registered, so an immediate
    // exit is still retired by the flusher.
    spawn_reader(reader, Arc::clone(&stream));
    spawn_flusher(stream, app, id.clone(), "stdout");
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
    let mut history = session.stream.lock();
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // Commits any staged pre-resize bytes ahead of the marker, so they need a
    // wakeup to leave the outbox even if the PTY then goes quiet.
    history.push_resize(rows, cols);
    drop(history);
    session.stream.wake.notify_all();
    session.rows = rows;
    session.cols = cols;
    Ok(())
}

#[tauri::command]
pub fn terminal_prepare_handoff(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    target_label: String,
) -> Result<String, String> {
    crate::require_main(window.label())?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state unavailable")?;
    sessions
        .get_mut(&session_id)
        .ok_or("Terminal session not found")?
        .access
        .prepare(window.label(), &target_label)
}

fn session_recipients(app: &AppHandle, id: &str) -> Vec<tauri::ipc::Channel<serde_json::Value>> {
    app.state::<TerminalState>()
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
        .map(|session| {
            session
                .subscribers
                .iter()
                .filter(|(label, _)| session.access.require(label).is_ok())
                .map(|(_, (_, channel))| channel.clone())
                .collect()
        })
        .unwrap_or_default()
}
fn emit_terminal<S: Serialize + Clone>(
    _app: &AppHandle,
    channels: &[tauri::ipc::Channel<serde_json::Value>],
    event: &str,
    payload: S,
) {
    // General event listeners can bypass target filters; use caller-bound IPC.
    let message = serde_json::json!({ "event": event, "payload": payload });
    for channel in channels {
        let _ = channel.send(message.clone());
    }
}
fn subscribe_session(
    session: &mut TerminalSession,
    caller: &str,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, String> {
    session.access.require(caller)?;
    let id = session_id()?;
    session
        .subscribers
        .insert(caller.into(), (id.clone(), channel));
    Ok(id)
}
#[tauri::command]
pub fn terminal_subscribe(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state unavailable")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("Terminal session not found")?;
    subscribe_session(session, window.label(), on_event)
}
#[tauri::command]
pub fn terminal_unsubscribe(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    subscription_id: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state unavailable")?;
    if let Some(session) = sessions.get_mut(&session_id) {
        if session
            .subscribers
            .get(window.label())
            .is_some_and(|(id, _)| id == &subscription_id)
        {
            session.subscribers.remove(window.label());
        }
    }
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
    handoff_token: Option<String>,
    reclaim: Option<bool>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .access
        .attach(window.label(), handoff_token.as_deref())?;
    if reclaim.unwrap_or(false) {
        crate::require_main(window.label())?;
        session.access.labels.retain(|label| label == "main");
        session.access.handoff = None;
        session.subscribers.retain(|label, _| label == "main");
    }
    resize_master(session, rows, cols)?;
    session.resize_owner = window.label().to_string();
    Ok(())
}

// Copies up to the whole history twice: run off the main (UI) thread, and
// hold the sessions lock only for the access check.
#[tauri::command(async)]
pub fn terminal_snapshot(
    window: tauri::Window,
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<TerminalSnapshot, String> {
    let stream = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "Terminal session not found".to_string())?;
        session.access.require_reader(window.label())?;
        Arc::clone(&session.stream)
    };
    // Staged-but-uncommitted bytes are deliberately excluded: they will arrive
    // as a live event with `seq > snapshot.seq`, which is exactly what the
    // frontend's replay/dedupe path expects.
    let history = stream.lock();
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
    session.access.require(window.label())?;
    if session.resize_owner != window.label() {
        return Ok(false);
    }
    resize_master(session, rows, cols)?;
    Ok(true)
}

/// Queued input chunks per session. A paste is one chunk.
const INPUT_QUEUE_CHUNKS: usize = 256;

/// One thread per session owns the PTY writer. It performs the blocking
/// `write_all`/`flush` in submission order and ends when the session drops its
/// sender or the PTY closes.
fn spawn_input_writer<W>(mut writer: W) -> mpsc::SyncSender<Vec<u8>>
where
    W: Write + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE_CHUNKS);
    let spawned = thread::Builder::new()
        .name("mesa-terminal-writer".to_string())
        .spawn(move || {
            while let Ok(chunk) = receiver.recv() {
                if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
                    return;
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("Mesa could not start the Pi input thread: {error}");
    }
    sender
}

/// Queue input without blocking: the sessions lock is released before the send.
fn queue_input(
    sessions: &Mutex<HashMap<String, TerminalSession>>,
    session_id: &str,
    input: String,
    caller: &str,
) -> Result<(), String> {
    let sessions = sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(session_id)
        .ok_or("Terminal session not found")?;
    session.access.require(caller)?;
    let sender = session.input.clone();
    drop(sessions);
    sender
        .try_send(input.into_bytes())
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => "Pi is not reading input; try again shortly".to_string(),
            mpsc::TrySendError::Disconnected(_) => "Terminal session has ended".to_string(),
        })
}

#[tauri::command]
pub fn terminal_write(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    queue_input(&state.sessions, &session_id, input, window.label())
}

#[tauri::command]
pub fn terminal_stop(
    window: tauri::Window,
    state: State<TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&session_id) {
        session.access.require(window.label())?;
    }
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
        // Waiting for a PTY child is allowed to block indefinitely on some
        // backends. Reap it away from the IPC thread so closing Pi cannot
        // freeze the renderer or the Tauri event loop.
        let mut child = session.child;
        let spawned = thread::Builder::new()
            .name("mesa-terminal-reaper".to_string())
            .spawn(move || {
                let _ = child.wait();
            });
        if let Err(error) = spawned {
            eprintln!("Mesa could not start the Pi exit thread: {error}");
        }
    }
    Ok(())
}

/// Destroyed windows cannot retain grants through a reused label.
pub fn revoke_window(state: &TerminalState, label: &str) {
    let mut sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
    for session in sessions.values_mut() {
        session.access.revoke(label);
        session.subscribers.remove(label);
        if session.resize_owner == label {
            session.resize_owner = "main".into();
        }
    }
}

/// Best-effort PTY teardown from RunEvent::Exit. Recover a poisoned session lock and never block app exit.
pub fn stop_all_sessions(state: &TerminalState) {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (_, mut session) in sessions.drain() {
        let _ = session.child.kill();
        // The process is already exiting. A non-blocking reap is useful when
        // the child stopped immediately, but shutdown must never wait for a
        // PTY backend or child process that fails to acknowledge termination.
        let _ = session.child.try_wait();
    }
}

#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;

#[cfg(test)]
mod access_tests {
    use super::*;
    #[test]
    fn research_viewers_can_only_read_output() {
        let mut access = SessionAccess::new("main");
        assert!(access.require_reader("research-x").is_ok());
        assert!(access.require("research-x").is_err());
        assert!(access.attach("research-x", None).is_err());
        assert!(access.require_reader("doc-x").is_err());
        assert!(access.require_reader("main").is_ok());
    }
    #[test]
    fn session_handoff_is_label_bound_single_use_and_expires() {
        let mut access = SessionAccess::new("main");
        for label in ["doc-one", "panel-one", "agent-other"] {
            assert!(access.require(label).is_err());
        }
        assert!(access.prepare("agent-other", "agent-new").is_err());
        let token = access.prepare("main", "agent-new").unwrap();
        assert!(access.attach("agent-other", Some(&token)).is_err());
        assert!(access.attach("agent-new", None).is_err());
        access.attach("agent-new", Some(&token)).unwrap();
        assert!(access.handoff.is_none());
        access.require("agent-new").unwrap();
        access.require("main").unwrap();
        assert!(access.attach("agent-other", Some(&token)).is_err());
        let second = access.prepare("main", "agent-next").unwrap();
        access.handoff.as_mut().unwrap().2 = Instant::now() - Duration::from_secs(31);
        assert!(access.attach("agent-next", Some(&second)).is_err());
        let second = access.prepare("main", "agent-next").unwrap();
        access.attach("agent-next", Some(&second)).unwrap();
        assert!(access.require("agent-new").is_err());
        access.revoke("agent-next");
        assert!(access.attach("agent-next", Some(&second)).is_err());
        assert!(access.require("agent-next").is_err());
        access.require("main").unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn subscriptions_require_the_session_grant_and_deliver_directly() {
        let mut session = super::tests::spawn_test_session("sleep 30");
        let messages = Arc::new(Mutex::new(Vec::new()));
        let sink = messages.clone();
        let channel = tauri::ipc::Channel::<serde_json::Value>::new(move |message| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = message {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        assert!(subscribe_session(&mut session, "agent-other", channel.clone()).is_err());
        assert!(session.subscribers.is_empty());
        subscribe_session(&mut session, "main", channel.clone()).unwrap();
        channel
            .send(serde_json::json!({"event":"terminal://output","payload":{"data":"private"}}))
            .unwrap();
        assert_eq!(messages.lock().unwrap()[0]["payload"]["data"], "private");
        session.child.kill().unwrap();
        session.child.wait().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn unauthorized_input_never_reaches_the_session_writer() {
        let mut sessions = HashMap::new();
        let mut session = super::tests::spawn_test_session("sleep 30");
        let (sender, receiver) = mpsc::sync_channel(1);
        session.input = sender;
        sessions.insert("session".into(), session);
        let sessions = Mutex::new(sessions);
        assert!(queue_input(&sessions, "session", "injected".into(), "agent-other").is_err());
        assert!(receiver.try_recv().is_err());
        queue_input(&sessions, "session", "allowed".into(), "main").unwrap();
        assert_eq!(receiver.try_recv().unwrap(), b"allowed");
        let mut sessions = sessions.lock().unwrap();
        let child = &mut sessions.get_mut("session").unwrap().child;
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
