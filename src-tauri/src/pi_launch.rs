// Pi executable discovery and launch commands: PATH and common install
// directories, cached resolution, and the Windows shim/Node fallbacks. Part
// of `terminal`.

use super::*;

pub(super) static PI_BINARY: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(target_os = "windows")]
pub(super) fn executable_names(name: &str) -> Vec<OsString> {
    let raw = Path::new(name);
    if raw.extension().is_some() {
        return vec![OsString::from(name)];
    }

    let pathext = env::var_os("PATHEXT").map(|value| value.to_string_lossy().to_string());
    let mut names: Vec<OsString> = launch_extensions(pathext.as_deref())
        .into_iter()
        .map(|ext| OsString::from(format!("{name}{ext}")))
        .collect();
    names.push(OsString::from(name));
    names
}

/// Extensions to try for a bare command name. Native images and the cmd
/// shims Mesa knows how to launch come first, whatever the user's PATHEXT
/// order, so a `pi.ps1` or `pi.js` beside `pi.cmd` is never chosen over it.
/// Other PATHEXT entries follow in their configured order.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn launch_extensions(pathext: Option<&str>) -> Vec<String> {
    const PREFERRED: [&str; 4] = [".EXE", ".COM", ".CMD", ".BAT"];
    let mut extensions: Vec<String> = PREFERRED.iter().map(|ext| ext.to_string()).collect();
    for ext in pathext
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|ext| ext.starts_with('.') && ext.len() > 1)
    {
        if !extensions
            .iter()
            .any(|known| known.eq_ignore_ascii_case(ext))
        {
            extensions.push(ext.to_string());
        }
    }
    extensions
}

#[cfg(target_os = "windows")]
pub(super) fn executable_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    for executable in executable_names(name) {
        let candidate = dir.join(executable);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub(super) fn executable_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if is_executable(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
pub(super) fn comspec() -> String {
    env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

pub(super) fn terminal_command(
    program: Option<&str>,
) -> Result<(CommandBuilder, Option<PathBuf>), String> {
    match program {
        Some("pi") => {
            let pi = resolve_pi_binary()?;
            let program_dir = pi.parent().map(Path::to_path_buf);
            let cmd = pi_command(&pi)?;
            Ok((cmd, program_dir))
        }
        _ => Err("only Pi can start in Mesa's terminal".into()),
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn pi_command(pi: &Path) -> Result<CommandBuilder, String> {
    Ok(CommandBuilder::new(pi.to_string_lossy().to_string()))
}

/// `cmd.exe` fallback for a `.cmd`/`.bat` shim. `call` keeps the first
/// character after `/c` from being a quote, so cmd preserves the quoted shim
/// path and quoted extension arguments (paths with spaces). The shim must not
/// find `node` or other helpers in the vault working directory.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn cmd_shim_command(comspec: &str, shim: &Path) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(comspec);
    cmd.args(["/d", "/c", "call"]);
    cmd.arg(shim.as_os_str());
    cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    cmd
}

/// True when the command runs through `cmd.exe` (`cmd_shim_command`).
pub(super) fn launches_through_cmd(cmd: &CommandBuilder) -> bool {
    cmd.get_argv()
        .get(1..4)
        .is_some_and(|args| args == ["/d", "/c", "call"])
}

/// Pi's working folder. Child processes get a plain spelling, never the
/// `\\?\` form canonicalize returns on Windows. On Windows the folder keeps
/// the spelling the user opened (a mapped drive such as `Z:\Vault` stays
/// `Z:`, which cmd.exe accepts) only when that spelling still resolves to the
/// approved canonical root; otherwise the canonical root is used. Other
/// platforms always use the canonical root.
pub(super) fn launch_cwd(requested: &str, canonical: &Path, windows: bool) -> PathBuf {
    let resolved = crate::vaultscope::plain_path(canonical);
    if !windows {
        return resolved;
    }
    let spelled = Path::new(requested);
    let plain = !(requested.starts_with("\\\\?\\") || requested.starts_with("//?/"));
    let same_folder = plain
        && spelled.is_absolute()
        && !spelled.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
        && crate::vaultscope::resolve_path(spelled).ok().as_deref() == Some(canonical);
    if !same_folder {
        return resolved;
    }
    if cfg!(windows) {
        PathBuf::from(requested.replace('/', "\\"))
    } else {
        spelled.to_path_buf()
    }
}

/// cmd.exe cannot use a UNC or verbatim working directory: it prints "UNC
/// paths are not supported" and starts in the Windows folder instead.
pub(super) fn cmd_accepts_cwd(cwd: &Path) -> bool {
    let text = cwd.to_string_lossy();
    !(text.starts_with("\\\\") || text.starts_with("//"))
}

/// The Node entry an npm `cmd-shim` wrapper runs, relative to the shim folder.
/// Only the standard npm template is recognized: `_prog` is Node and the
/// entry is a `.js`/`.cjs`/`.mjs` file under `%dp0%` without `..`, so Mesa
/// can start Node itself instead of going through cmd.exe.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn npm_shim_node_entry(shim: &str) -> Option<String> {
    let lower = shim.to_ascii_lowercase();
    if !lower.contains("set \"_prog=node\"") {
        return None;
    }
    let line = shim
        .lines()
        .find(|line| line.contains("\"%_prog%\"") && line.trim_end().ends_with("%*"))?;
    let after = &line[line.find("\"%_prog%\"")? + "\"%_prog%\"".len()..];
    let start = after.find("\"%dp0%\\")? + "\"%dp0%\\".len();
    let rel = &after[start..];
    let rel = &rel[..rel.find('"')?];
    let parts: Vec<&str> = rel.split(['\\', '/']).collect();
    let valid = parts.iter().all(|part| {
        !part.is_empty()
            && *part != "."
            && *part != ".."
            && !part.contains(['%', ':', '"', '*', '?', '<', '>', '|'])
    });
    let lower_rel = rel.to_ascii_lowercase();
    (valid
        && [".js", ".cjs", ".mjs"]
            .iter()
            .any(|ext| lower_rel.ends_with(ext)))
    .then(|| parts.join("\\"))
}

#[cfg(target_os = "windows")]
pub(super) fn npm_shim_node_command(shim: &Path) -> Option<Result<CommandBuilder, String>> {
    let mut text = String::new();
    fs::File::open(shim)
        .ok()?
        .take(16 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    let folder = shim.parent()?;
    let entry = folder.join(npm_shim_node_entry(&text)?);
    entry.is_file().then(|| node_command(folder, &entry))
}

#[cfg(target_os = "windows")]
pub(super) fn pi_command(pi: &Path) -> Result<CommandBuilder, String> {
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
            // Start Node directly when the shim is npm's: no cmd.exe, so a
            // network (UNC) vault can still be Pi's working directory.
            if let Some(command) = npm_shim_node_command(pi) {
                return command;
            }

            return Ok(cmd_shim_command(&comspec(), pi));
        }
    }

    Err("Resolved Pi launcher is not a native Windows executable, Node-backed script, or runnable .cmd/.bat shim. Point MESA_PI_BIN at the native Pi launcher or its adjacent Node script.".into())
}

#[cfg(unix)]
pub(super) fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub(super) fn is_executable(path: &Path) -> bool {
    path.is_file()
}

pub(super) fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

pub(super) fn common_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(home) = home_dir() {
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

pub(super) fn resolve_pi_binary() -> Result<PathBuf, String> {
    resolve_cached_pi_binary(&PI_BINARY, find_pi_binary)
}

pub(super) fn resolve_cached_pi_binary(
    cache: &Mutex<Option<PathBuf>>,
    find: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(path) = cached.as_ref().filter(|path| is_executable(path)) {
        return Ok(path.clone());
    }
    *cached = None;
    let resolved = find()?;
    *cached = Some(resolved.clone());
    Ok(resolved)
}

pub(super) fn find_pi_binary() -> Result<PathBuf, String> {
    for key in ["MESA_PI_BIN", "PI_BIN"] {
        if let Some(raw) = env::var_os(key).filter(|value| !value.is_empty()) {
            let candidate = PathBuf::from(raw);
            if let Some(executable) = resolve_explicit_pi_candidate(&candidate) {
                return Ok(executable);
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            if let Some(executable) = executable_in_dir(&dir, "pi") {
                return Ok(executable);
            }
        }
    }

    for dir in common_bin_dirs() {
        if let Some(executable) = executable_in_dir(&dir, "pi") {
            return Ok(executable);
        }
    }

    Err("Unable to spawn Pi. Checked PATH, user-local package locations, and Mesa's standard Pi locations. Set MESA_PI_BIN or install Pi in a standard bin directory.".into())
}

#[cfg(target_os = "windows")]
pub(super) fn resolve_explicit_pi_candidate(candidate: &Path) -> Option<PathBuf> {
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
pub(super) fn resolve_explicit_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    is_executable(candidate).then(|| candidate.to_path_buf())
}

#[cfg(target_os = "windows")]
pub(super) fn windows_launches_directly(path: &Path) -> bool {
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
pub(super) fn file_starts_with_mz(path: &Path) -> bool {
    let mut magic = [0u8; 2];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok_and(|()| &magic == b"MZ")
}

#[cfg(target_os = "windows")]
pub(super) fn script_uses_node(path: &Path) -> bool {
    let mut head = Vec::new();
    if fs::File::open(path)
        .and_then(|file| file.take(512).read_to_end(&mut head))
        .is_err()
    {
        return false;
    }
    let line = head.split(|byte| *byte == b'\n').next().unwrap_or_default();
    std::str::from_utf8(line).is_ok_and(|line| line.starts_with("#!") && line.contains("node"))
}

#[cfg(target_os = "windows")]
pub(super) fn sibling_script_path(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?;
    let sibling = path.with_file_name(stem);
    sibling.is_file().then_some(sibling)
}

#[cfg(target_os = "windows")]
pub(super) fn node_script_command(script: &Path) -> Result<CommandBuilder, String> {
    node_command(script.parent().unwrap_or(script), script)
}

/// Node for `script`, preferring a `node.exe` in `near` as npm shims do.
#[cfg(target_os = "windows")]
pub(super) fn node_command(near: &Path, script: &Path) -> Result<CommandBuilder, String> {
    let node = resolve_node_binary_near(near)?;
    let mut cmd = CommandBuilder::new(node.to_string_lossy().to_string());
    cmd.arg(script.to_string_lossy().to_string());
    Ok(cmd)
}

#[cfg(all(target_os = "windows", test))]
pub(super) fn resolve_node_binary_for_script(script: &Path) -> Result<PathBuf, String> {
    resolve_node_binary_near(script.parent().unwrap_or(script))
}

#[cfg(target_os = "windows")]
pub(super) fn resolve_node_binary_near(parent: &Path) -> Result<PathBuf, String> {
    for candidate in [parent.join("node.exe"), parent.join("node")] {
        if candidate.is_file() && windows_launches_directly(&candidate) {
            return Ok(candidate);
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

    Err("Pi resolved to a Node script, but Mesa could not find node.exe to launch it. Install Node.js or point MESA_PI_BIN at a native Pi executable.".into())
}

/// Pi's own directory first, then the inherited PATH, then common install
/// directories as fallbacks; a common directory never shadows the user's PATH.
pub(super) fn merged_path(
    program_dir: Option<&Path>,
    inherited: Option<OsString>,
    fallbacks: &[PathBuf],
) -> Option<OsString> {
    let mut paths: Vec<PathBuf> = Vec::new();

    if let Some(dir) = program_dir.filter(|dir| dir.is_dir()) {
        paths.push(dir.to_path_buf());
    }

    if let Some(existing) = inherited {
        for path in env::split_paths(&existing) {
            if !paths.iter().any(|candidate| candidate == &path) {
                paths.push(path);
            }
        }
    }

    for dir in fallbacks {
        if dir.is_dir() && !paths.iter().any(|existing| existing == dir) {
            paths.push(dir.clone());
        }
    }

    if paths.is_empty() {
        return None;
    }

    env::join_paths(paths).ok()
}
