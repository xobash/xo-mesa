// Self-update from Mesa's signed release feed (`docs/updates.md`).
//
// Update traffic goes only to the endpoint in `tauri.conf.json` (the
// `latest.json` asset of the newest GitHub release of xobash/xo-mesa) and the
// package it names. Requests carry no identifier: a fixed URL with no
// version or device fields and the plugin's own User-Agent. Every package is
// verified against the minisign public key in `tauri.conf.json`, including
// the version signed into it. A placeholder or unreadable key turns updates
// off before any request.
//
// Nothing is installed while Mesa runs. On every platform a verified package
// is staged on disk (`update_install.rs`) and installed only:
// - during the guarded quit, after the renderer's save flush
//   (`install_staged_on_quit`, from `quit_after_save`), or
// - on Restart to update, after the renderer's flush, refused while Pi runs
//   (`updater_restart`), then relaunched.
// Before installing, the staged file is verified again. Installs never show
// a prompt: macOS swaps the `.app` with Mesa's own renames (the plugin would
// fall back to an administrator prompt), Linux AppImage and Windows per-user
// NSIS (quiet mode) use the plugin. Installs that would need an administrator
// or a package manager (MSI, deb, rpm, a protected macOS folder) only report
// the new version (`install_support`).

use crate::update_install;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;
use tokio_util::sync::CancellationToken;

/// Status changes for the main window only, throttled while downloading.
pub(crate) const STATUS_EVENT: &str = "mesa://update-status";
/// Shipped in `tauri.conf.json` until the owner adds the real key. It is not
/// a minisign key, so a build carrying it never checks or installs anything.
pub(crate) const PLACEHOLDER_PUBKEY: &str = "MESA_UPDATER_PUBLIC_KEY_NOT_SET";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// At most one progress event per interval, and only when the whole percent
/// changes: a download emits at most about 101 progress events.
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Without a Content-Length there is no percent; report bytes once a second.
pub(crate) const UNKNOWN_TOTAL_INTERVAL: Duration = Duration::from_secs(1);
/// An automatic check downloads a version that failed at most once a day.
pub(crate) const RETRY_AFTER_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_FAILURE_RECORD_BYTES: u64 = 4096;

pub(crate) const NOT_READY: &str = "No update is ready to install yet.";
pub(crate) const PI_RUNNING: &str = "Stop Pi before restarting to update.";
const NOT_FOUND: &str = "Check for updates first.";
const MANUAL_ONLY: &str = "This copy of Mesa is updated by hand.";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Phase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    /// Found and not downloaded: automatic updates are off, the version is
    /// backing off after a failure, or this install is updated by hand.
    Available {
        version: String,
    },
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
        percent: Option<u8>,
    },
    /// Verified and staged; installs at quit or on Restart.
    Ready {
        version: String,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Support {
    /// Download, verify and install without any prompt.
    Automatic,
    /// Check only; installing here needs an administrator or package manager.
    NotifyOnly { reason: String },
    /// No update traffic at all.
    Off { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FailureKind {
    Download,
    Signature,
    Install,
}

/// The one remembered failure: which version, why, and when (Unix ms).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FailedAttempt {
    pub(crate) version: String,
    pub(crate) kind: FailureKind,
    pub(crate) at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    /// Increases with every change; the renderer drops older statuses.
    seq: u64,
    current_version: String,
    support: Support,
    #[serde(flatten)]
    phase: Phase,
    /// Unix milliseconds of the last completed check.
    checked_at: Option<u64>,
    last_failure: Option<FailedAttempt>,
}

/// The status state machine. Each transition applies only from the phases
/// named in its doc, bumps `seq` when it applies and returns whether it did.
#[derive(Debug, Default)]
pub(crate) struct Machine {
    pub(crate) phase: Phase,
    pub(crate) checked_at: Option<u64>,
    pub(crate) seq: u64,
}

impl Machine {
    fn set(&mut self, phase: Phase) -> bool {
        self.phase = phase;
        self.seq += 1;
        true
    }

    /// From Idle, UpToDate, Available or Error. A check never overlaps
    /// another, a download or a ready update.
    pub(crate) fn begin_check(&mut self) -> bool {
        matches!(
            self.phase,
            Phase::Idle | Phase::UpToDate | Phase::Available { .. } | Phase::Error { .. }
        ) && self.set(Phase::Checking)
    }

    /// From Checking.
    pub(crate) fn up_to_date(&mut self, now_ms: u64) -> bool {
        if self.phase != Phase::Checking {
            return false;
        }
        self.checked_at = Some(now_ms);
        self.set(Phase::UpToDate)
    }

    /// From Checking: Downloading when `download`, otherwise Available.
    pub(crate) fn found(&mut self, version: String, download: bool, now_ms: u64) -> bool {
        if self.phase != Phase::Checking {
            return false;
        }
        self.checked_at = Some(now_ms);
        self.set(if download {
            downloading(version)
        } else {
            Phase::Available { version }
        })
    }

    /// From Available: the explicit "Download and install".
    pub(crate) fn begin_download(&mut self) -> bool {
        let Phase::Available { version } = &self.phase else {
            return false;
        };
        let next = downloading(version.clone());
        self.set(next)
    }

    /// While Downloading: count a chunk and return the whole percent, if the
    /// total is known. `None` outside a download.
    pub(crate) fn progress(&mut self, chunk: u64, length: Option<u64>) -> Option<Option<u8>> {
        let Phase::Downloading {
            downloaded,
            total,
            percent,
            ..
        } = &mut self.phase
        else {
            return None;
        };
        *downloaded = downloaded.saturating_add(chunk);
        *total = length.filter(|length| *length > 0);
        *percent = total.map(|total| percent_of(*downloaded, total));
        let counted = *percent;
        self.seq += 1;
        Some(counted)
    }

    /// From Downloading: back to Available (automatic updates turned off).
    pub(crate) fn cancel_download(&mut self) -> bool {
        let Phase::Downloading { version, .. } = &self.phase else {
            return false;
        };
        let next = Phase::Available {
            version: version.clone(),
        };
        self.set(next)
    }

    /// From Downloading.
    pub(crate) fn staged(&mut self) -> bool {
        let Phase::Downloading { version, .. } = &self.phase else {
            return false;
        };
        let next = Phase::Ready {
            version: version.clone(),
        };
        self.set(next)
    }

    /// From Checking or Downloading.
    pub(crate) fn fail(&mut self, message: String) -> bool {
        matches!(self.phase, Phase::Checking | Phase::Downloading { .. })
            && self.set(Phase::Error { message })
    }

    /// From Ready: the staged package could not be installed.
    pub(crate) fn install_failed(&mut self, message: String) -> bool {
        self.is_ready() && self.set(Phase::Error { message })
    }

    pub(crate) fn is_ready(&self) -> bool {
        matches!(self.phase, Phase::Ready { .. })
    }
}

fn downloading(version: String) -> Phase {
    Phase::Downloading {
        version,
        downloaded: 0,
        total: None,
        percent: None,
    }
}

pub(crate) fn percent_of(done: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    let percent = u128::from(done.min(total)) * 100 / u128::from(total);
    u8::try_from(percent).unwrap_or(100)
}

/// Windows IPC cost: every event repaints the UI thread, so progress is
/// throttled here in Rust (`PROGRESS_INTERVAL`, one event per whole percent).
/// Reaching 100% is always reported.
#[derive(Default)]
pub(crate) struct ProgressThrottle {
    pub(crate) last: Option<(Instant, Option<u8>)>,
}

impl ProgressThrottle {
    pub(crate) fn admit(&mut self, now: Instant, percent: Option<u8>) -> bool {
        let due = match self.last {
            None => true,
            Some((_, last)) if percent == Some(100) => last != Some(100),
            Some((at, last)) => {
                let interval = if percent.is_some() {
                    PROGRESS_INTERVAL
                } else {
                    UNKNOWN_TOTAL_INTERVAL
                };
                now.saturating_duration_since(at) >= interval
                    && (percent.is_none() || percent != last)
            }
        };
        if due {
            self.last = Some((now, percent));
        }
        due
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CheckOutcome<T> {
    UpToDate,
    Found(T),
    Failed(String),
}

/// No published feed yet (GitHub answers 404, which the plugin reports as
/// `ReleaseNotFound`) means nothing newer exists: up to date, not an error.
pub(crate) fn check_outcome<T>(
    checked: Result<Option<T>, tauri_plugin_updater::Error>,
) -> CheckOutcome<T> {
    match checked {
        Ok(None) | Err(tauri_plugin_updater::Error::ReleaseNotFound) => CheckOutcome::UpToDate,
        Ok(Some(update)) => CheckOutcome::Found(update),
        Err(error) => CheckOutcome::Failed(plain_message(&error)),
    }
}

/// An automatic download of `version` waits a day after it last failed.
pub(crate) fn download_allowed(last: Option<&FailedAttempt>, version: &str, now_ms: u64) -> bool {
    !last.is_some_and(|failed| {
        failed.version == version && now_ms.saturating_sub(failed.at_ms) < RETRY_AFTER_MS
    })
}

/// A restart needs a ready update and no running Pi session. Unsaved edits
/// are the renderer's to flush before it asks (`src/lib/updates.ts`).
pub(crate) fn restart_admission(ready: bool, pi_running: bool) -> Result<(), String> {
    if !ready {
        return Err(NOT_READY.into());
    }
    if pi_running {
        return Err(PI_RUNNING.into());
    }
    Ok(())
}

/// Where release packages live (`scripts/release-updater.mjs` `DOWNLOAD_BASE`).
const OFFICIAL_PACKAGE_SEGMENTS: [&str; 4] = ["xobash", "xo-mesa", "releases", "download"];

/// `latest.json` is unsigned, so the package URL it names is checked before
/// any request: only `https://github.com/xobash/xo-mesa/releases/download/<tag>/<name>`.
/// GitHub then redirects to its asset host; the plugin follows that redirect
/// from github.com, and the signature check still covers the bytes.
pub(crate) fn official_package_url(url: &url::Url) -> bool {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<&str> = segments.take(OFFICIAL_PACKAGE_SEGMENTS.len() + 3).collect();
    segments.len() == OFFICIAL_PACKAGE_SEGMENTS.len() + 2
        && segments[..OFFICIAL_PACKAGE_SEGMENTS.len()] == OFFICIAL_PACKAGE_SEGMENTS
        && segments[OFFICIAL_PACKAGE_SEGMENTS.len()..]
            .iter()
            .all(|segment| package_segment_ok(segment))
}

/// A tag or file name: not empty, not a dot segment, no encoded separator or dot.
fn package_segment_ok(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('\\')
        && !["%2e", "%2f", "%5c"]
            .iter()
            .any(|code| lower.contains(code))
}

/// The same decode the plugin does before verifying a package. Anything that
/// is not a minisign public key (the placeholder included) is unusable.
pub(crate) fn pubkey_usable(key: &str) -> bool {
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(key.trim()) else {
        return false;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return false;
    };
    minisign_verify::PublicKey::decode(&text).is_ok()
}

pub(crate) fn failure_kind(error: &tauri_plugin_updater::Error) -> FailureKind {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => FailureKind::Signature,
        E::Reqwest(_) | E::Network(_) => FailureKind::Download,
        _ => FailureKind::Install,
    }
}

/// Short plain text for the Settings status line.
pub(crate) fn plain_message(error: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(_) | E::Network(_) => {
            "Couldn't reach the update server. Check your connection and try again."
        }
        E::ReleaseNotFound => "No published update was found.",
        E::TargetNotFound(_) | E::TargetsNotFound(_) => {
            "No update is published for this computer yet."
        }
        E::UnsupportedOs | E::UnsupportedArch => "Updates are not available for this system.",
        _ if failure_kind(error) == FailureKind::Signature => update_install::SIGNATURE_REFUSED,
        _ => "The update could not be installed. Mesa will try again later.",
    }
    .to_string()
}

/// Read the remembered failure; anything missing, oversized or malformed is none.
pub(crate) fn load_failure(path: &Path) -> Option<FailedAttempt> {
    use std::io::Read;
    let mut text = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_FAILURE_RECORD_BYTES + 1)
        .read_to_end(&mut text)
        .ok()?;
    if text.len() as u64 > MAX_FAILURE_RECORD_BYTES {
        return None;
    }
    serde_json::from_slice(&text).ok()
}

/// Remember (or, with `None`, forget) the one failed attempt. Best effort:
/// losing it only allows one extra retry.
pub(crate) fn save_failure(path: &Path, failure: Option<&FailedAttempt>) {
    match failure.and_then(|failure| serde_json::to_vec(failure).ok()) {
        Some(bytes) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, bytes);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct Staged {
    update: tauri_plugin_updater::Update,
    path: PathBuf,
}

#[derive(Default)]
pub(crate) struct UpdaterState {
    machine: Mutex<Machine>,
    support: OnceLock<Support>,
    /// The last update a check found, for "Download and install".
    found: Mutex<Option<tauri_plugin_updater::Update>>,
    staged: Mutex<Option<Staged>>,
    cancel: Mutex<Option<CancellationToken>>,
    failure: Mutex<Option<FailedAttempt>>,
    failure_loaded: OnceLock<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl UpdaterState {
    fn machine(&self) -> MutexGuard<'_, Machine> {
        lock(&self.machine)
    }

    fn failure<R: Runtime>(&self, app: &AppHandle<R>) -> MutexGuard<'_, Option<FailedAttempt>> {
        self.failure_loaded.get_or_init(|| {
            *lock(&self.failure) = failure_path(app).and_then(|path| load_failure(&path));
        });
        lock(&self.failure)
    }
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_cache_dir().ok()
}

fn failure_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    cache_dir(app).map(|dir| dir.join("update-failure.json"))
}

fn package_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    cache_dir(app).map(|dir| dir.join("update-package"))
}

fn record_failure<R: Runtime>(app: &AppHandle<R>, failure: Option<FailedAttempt>) {
    let state = app.state::<UpdaterState>();
    let mut current = state.failure(app);
    if let Some(path) = failure_path(app) {
        save_failure(&path, failure.as_ref());
    }
    *current = failure;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or_default()
        .to_string()
}

fn support<R: Runtime>(app: &AppHandle<R>) -> Support {
    app.state::<UpdaterState>()
        .support
        .get_or_init(|| detect_support(app))
        .clone()
}

fn detect_support<R: Runtime>(app: &AppHandle<R>) -> Support {
    if cfg!(debug_assertions) {
        return Support::Off {
            reason: "Updates are off in development builds.".into(),
        };
    }
    let key = configured_pubkey(app);
    if key == PLACEHOLDER_PUBKEY || !pubkey_usable(&key) {
        return Support::Off {
            reason: "This build has no update signing key, so it never updates itself.".into(),
        };
    }
    install_support(app)
}

const MANUAL_DOWNLOAD: &str = "Download it from Mesa's Releases page.";

#[cfg(target_os = "macos")]
fn current_bundle() -> Option<PathBuf> {
    tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe).ok())
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
}

#[cfg(target_os = "macos")]
fn install_support<R: Runtime>(_app: &AppHandle<R>) -> Support {
    // A cheap screen so a protected folder never downloads; the swap itself
    // still refuses quietly if the folder turns out to be protected.
    match current_bundle() {
        Some(bundle) if writable(&bundle) && bundle.parent().is_some_and(writable) => {
            Support::Automatic
        }
        _ => Support::NotifyOnly {
            reason: format!("Mesa's folder needs an administrator to change. {MANUAL_DOWNLOAD}"),
        },
    }
}

#[cfg(target_os = "linux")]
fn install_support<R: Runtime>(app: &AppHandle<R>) -> Support {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        // deb and rpm installs ask for a password (pkexec, zenity or sudo).
        Some(BundleType::Deb | BundleType::Rpm) => Support::NotifyOnly {
            reason: "Install it with your package manager.".into(),
        },
        Some(BundleType::AppImage) => match app.env().appimage.map(PathBuf::from) {
            Some(image) if writable(&image) && image.parent().is_some_and(writable) => {
                Support::Automatic
            }
            _ => Support::NotifyOnly {
                reason: format!("Mesa's AppImage is in a read-only folder. {MANUAL_DOWNLOAD}"),
            },
        },
        _ => Support::Off {
            reason: "This copy of Mesa was not installed from a release package.".into(),
        },
    }
}

#[cfg(windows)]
fn install_support<R: Runtime>(_app: &AppHandle<R>) -> Support {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        // Per-user NSIS installs need no elevation and run quietly.
        Some(BundleType::Nsis) => Support::Automatic,
        Some(BundleType::Msi) => Support::NotifyOnly {
            reason: format!("MSI installs need an administrator. {MANUAL_DOWNLOAD}"),
        },
        _ => Support::Off {
            reason: "This copy of Mesa was not installed from a release package.".into(),
        },
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn install_support<R: Runtime>(_app: &AppHandle<R>) -> Support {
    Support::Off {
        reason: "Updates are not available for this system.".into(),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

fn snapshot<R: Runtime>(app: &AppHandle<R>) -> UpdateStatus {
    let support = support(app);
    let state = app.state::<UpdaterState>();
    let last_failure = state.failure(app).clone();
    let machine = state.machine();
    UpdateStatus {
        seq: machine.seq,
        current_version: app.package_info().version.to_string(),
        support,
        phase: machine.phase.clone(),
        checked_at: machine.checked_at,
        last_failure,
    }
}

fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to("main", STATUS_EVENT, snapshot(app));
}

/// Start a check unless updates are off or one is already running. With
/// `download`, an installable update downloads at once (unless it is backing
/// off). Returns at once; the work runs on the async runtime.
fn start_check<R: Runtime>(app: &AppHandle<R>, download: bool) {
    if matches!(support(app), Support::Off { .. }) {
        return;
    }
    if !app.state::<UpdaterState>().machine().begin_check() {
        return;
    }
    emit_status(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if run_check(&app, download).await {
            emit_status(&app);
        }
    });
}

/// Returns whether the status changed after the last emitted one.
async fn run_check<R: Runtime>(app: &AppHandle<R>, download: bool) -> bool {
    let state = app.state::<UpdaterState>();
    if lock(&state.staged).is_none() {
        // A package left by an install that exited the process (Windows).
        if let Some(dir) = package_dir(app) {
            let _ =
                tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
        }
    }
    let checked = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let update = match check_outcome(checked) {
        CheckOutcome::UpToDate => return state.machine().up_to_date(now_ms()),
        CheckOutcome::Failed(message) => return state.machine().fail(message),
        CheckOutcome::Found(update) => update,
    };
    let now = now_ms();
    let download = download
        && support(app) == Support::Automatic
        && download_allowed(state.failure(app).as_ref(), &update.version, now);
    *lock(&state.found) = Some(update.clone());
    if !state.machine().found(update.version.clone(), download, now) {
        return false;
    }
    if !download {
        return true;
    }
    emit_status(app);
    run_download(app, update).await
}

/// Download, verify (inside the plugin) and stage one package. Cancellable
/// through `updater_cancel`. Returns whether the status changed.
async fn run_download<R: Runtime>(
    app: &AppHandle<R>,
    mut update: tauri_plugin_updater::Update,
) -> bool {
    let state = app.state::<UpdaterState>();
    if !official_package_url(&update.download_url) {
        record_failure(
            app,
            Some(FailedAttempt {
                version: update.version.clone(),
                kind: FailureKind::Signature,
                at_ms: now_ms(),
            }),
        );
        return state
            .machine()
            .fail(update_install::SIGNATURE_REFUSED.into());
    }
    let token = CancellationToken::new();
    *lock(&state.cancel) = Some(token.clone());
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut throttle = ProgressThrottle::default();
    let download = update.download(
        |chunk, length| {
            let counted = state.machine().progress(chunk as u64, length);
            if let Some(percent) = counted {
                if throttle.admit(Instant::now(), percent) {
                    emit_status(app);
                }
            }
        },
        || {},
    );
    let downloaded = tokio::select! {
        result = download => Some(result),
        () = token.cancelled() => None,
    };
    *lock(&state.cancel) = None;
    let Some(downloaded) = downloaded else {
        return state.machine().cancel_download();
    };
    let staged = match downloaded {
        Ok(bytes) => stage(app, bytes).await,
        Err(error) => Err((failure_kind(&error), plain_message(&error))),
    };
    match staged {
        Ok(path) => {
            record_failure(app, None);
            *lock(&state.staged) = Some(Staged { update, path });
            state.machine().staged()
        }
        Err((kind, message)) => {
            record_failure(
                app,
                Some(FailedAttempt {
                    version: update.version.clone(),
                    kind,
                    at_ms: now_ms(),
                }),
            );
            state.machine().fail(message)
        }
    }
}

async fn stage<R: Runtime>(
    app: &AppHandle<R>,
    bytes: Vec<u8>,
) -> Result<PathBuf, (FailureKind, String)> {
    let failed = |message: String| (FailureKind::Install, message);
    let dir =
        package_dir(app).ok_or_else(|| failed("Mesa has no folder for the update.".into()))?;
    tauri::async_runtime::spawn_blocking(move || update_install::stage_package(&dir, &bytes))
        .await
        .map_err(|_| failed("Mesa could not save the update.".into()))?
        .map_err(failed)
}

/// Install the staged package now, after verifying it again from disk. On
/// Windows a successful install exits the process (with `relaunch`, the quiet
/// installer starts Mesa again).
fn take_and_install<R: Runtime>(app: &AppHandle<R>, relaunch: bool) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let staged = lock(&state.staged).take().ok_or(NOT_READY)?;
    let result = update_install::read_staged(&staged.path).and_then(|bytes| {
        update_install::verify_package(
            &bytes,
            &staged.update.signature,
            &configured_pubkey(app),
            &staged.update.version,
        )?;
        platform_install(app, &staged.update, bytes, relaunch)
    });
    let _ = std::fs::remove_file(&staged.path);
    if result.is_err() {
        record_failure(
            app,
            Some(FailedAttempt {
                version: staged.update.version.clone(),
                kind: FailureKind::Install,
                at_ms: now_ms(),
            }),
        );
    }
    result
}

#[cfg(target_os = "macos")]
fn platform_install<R: Runtime>(
    _app: &AppHandle<R>,
    _update: &tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    _relaunch: bool,
) -> Result<(), String> {
    let bundle = current_bundle().ok_or(update_install::BUNDLE_REFUSED)?;
    update_install::swap_bundle(&bundle, &bytes)
}

#[cfg(target_os = "linux")]
fn platform_install<R: Runtime>(
    _app: &AppHandle<R>,
    update: &tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    _relaunch: bool,
) -> Result<(), String> {
    // AppImage only (`install_support`): renames and writes, no prompt.
    update.install(bytes).map_err(|error| plain_message(&error))
}

#[cfg(windows)]
fn platform_install<R: Runtime>(
    app: &AppHandle<R>,
    update: &tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    relaunch: bool,
) -> Result<(), String> {
    // `install` exits without `RunEvent::Exit`: stop Pi (its Job Object would
    // also end it), the activity server and the single-instance lock first,
    // so a relaunched Mesa is not mistaken for this one.
    crate::terminal::stop_all_sessions(&app.state::<crate::terminal::TerminalState>());
    let _ = crate::activity::stop_native();
    tauri_plugin_single_instance::destroy(app);
    update
        .clone()
        .restart_after_install(relaunch)
        .install(bytes)
        .map_err(|error| plain_message(&error))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_install<R: Runtime>(
    _app: &AppHandle<R>,
    _update: &tauri_plugin_updater::Update,
    _bytes: Vec<u8>,
    _relaunch: bool,
) -> Result<(), String> {
    Err(MANUAL_ONLY.into())
}

/// From `quit_after_save`, after the renderer's verified save flush: install
/// a staged update without relaunching. Failure never stops the quit.
pub(crate) fn install_staged_on_quit<R: Runtime>(app: &AppHandle<R>) {
    if lock(&app.state::<UpdaterState>().staged).is_none() {
        return;
    }
    if let Err(message) = take_and_install(app, false) {
        eprintln!("Mesa could not install its update at quit: {message}");
    }
}

#[tauri::command(async)]
pub(crate) fn updater_status(
    window: tauri::Window,
    app: AppHandle,
) -> Result<UpdateStatus, String> {
    crate::require_main(window.label())?;
    Ok(snapshot(&app))
}

/// Check now. `download` is the Automatic updates setting: off means the
/// check only reports a new version.
#[tauri::command(async)]
pub(crate) fn updater_check(
    window: tauri::Window,
    app: AppHandle,
    download: bool,
) -> Result<UpdateStatus, String> {
    crate::require_main(window.label())?;
    start_check(&app, download);
    Ok(snapshot(&app))
}

/// "Download and install" for a found update (automatic updates off, or a
/// version backing off after a failure).
#[tauri::command(async)]
pub(crate) fn updater_download(
    window: tauri::Window,
    app: AppHandle,
) -> Result<UpdateStatus, String> {
    crate::require_main(window.label())?;
    if support(&app) != Support::Automatic {
        return Err(MANUAL_ONLY.into());
    }
    let state = app.state::<UpdaterState>();
    let update = lock(&state.found).clone().ok_or(NOT_FOUND)?;
    if state.machine().begin_download() {
        emit_status(&app);
        let task = app.clone();
        tauri::async_runtime::spawn(async move {
            if run_download(&task, update).await {
                emit_status(&task);
            }
        });
    }
    Ok(snapshot(&app))
}

/// Stop an in-flight download (automatic updates turned off).
#[tauri::command(async)]
pub(crate) fn updater_cancel(
    window: tauri::Window,
    app: AppHandle,
) -> Result<UpdateStatus, String> {
    crate::require_main(window.label())?;
    if let Some(token) = lock(&app.state::<UpdaterState>().cancel).as_ref() {
        token.cancel();
    }
    Ok(snapshot(&app))
}

/// Install a ready update and relaunch. The renderer has already flushed
/// every edit (`restartToUpdate`); Pi must not be running.
#[tauri::command(async)]
pub(crate) fn updater_restart(window: tauri::Window, app: AppHandle) -> Result<(), String> {
    crate::require_main(window.label())?;
    let state = app.state::<UpdaterState>();
    restart_admission(
        state.machine().is_ready(),
        crate::terminal::has_running_session(&app.state::<crate::terminal::TerminalState>()),
    )?;
    // The renderer already saved; the relaunch must not ask it again.
    let armed = crate::set_quit_guard(&app, false);
    if let Err(message) = take_and_install(&app, true) {
        crate::set_quit_guard(&app, armed);
        if state.machine().install_failed(message.clone()) {
            emit_status(&app);
        }
        return Err(message);
    }
    // Windows never returns here: its quiet installer relaunches Mesa. The
    // restart fires `RunEvent::Exit` (Pi teardown, the single-instance lock
    // released) before the new process starts.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
#[path = "updater_tests.rs"]
mod tests;
