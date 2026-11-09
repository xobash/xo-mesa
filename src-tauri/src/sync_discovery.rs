// LAN discovery: UDP broadcast announcements of this device's TLS fingerprint
// and a filtered, rate-limited `sync://discovered` event stream. Off by
// default; the open Sync modal grants temporary consent.

use super::*;

const DISCOVERY_PORT: u16 = 47887;
const DISCOVERY_EVENT: &str = "sync://discovered";

struct DiscoveryState {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct DiscoveryPacket {
    #[serde(rename = "mesaDiscovery")]
    pub(super) mesa_discovery: bool,
    pub(super) version: String,
    pub(super) name: String,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) protocol: String,
    pub(super) listening: bool,
    pub(super) fingerprint: String,
}

fn discovery_state() -> &'static Mutex<Option<DiscoveryState>> {
    static S: OnceLock<Mutex<Option<DiscoveryState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

// Identity creation and the discovery lock can block: run off the UI thread.
#[tauri::command(async)]
pub fn sync_discovery_start(
    app: tauri::AppHandle,
    name: String,
    port: u16,
    listening: bool,
) -> Result<(), String> {
    use std::net::UdpSocket;

    let mut guard = discovery_state().lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let socket = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;

    let running = Arc::new(AtomicBool::new(true));
    let running_thread = running.clone();
    // Advertise this device's stable TLS certificate fingerprint so peers can
    // pin it. It doubles as the self-filter id (own packets are ignored).
    let fingerprint = get_identity(&app)?.fingerprint.clone();
    let host = local_lan_ip().unwrap_or_else(|_| "0.0.0.0".to_string());
    let own = DiscoveryPacket {
        mesa_discovery: true,
        version: "2.0".to_string(),
        name: if name.trim().is_empty() {
            "Mesa device".to_string()
        } else {
            name.trim().to_string()
        },
        host,
        port,
        protocol: "https".to_string(),
        listening,
        fingerprint: fingerprint.clone(),
    };
    let handle = std::thread::spawn(move || {
        let Ok(payload) = serde_json::to_vec(&own) else {
            return;
        };
        run_discovery_loop(
            &socket,
            &running_thread,
            &payload,
            DiscoveryFilter::new(fingerprint),
            |packet| {
                let _ = app.emit(DISCOVERY_EVENT, packet);
            },
            |pause| pause_while_running(&running_thread, pause),
        );
    });
    *guard = Some(DiscoveryState {
        running,
        handle: Some(handle),
    });
    Ok(())
}

/// The discovery socket operations, so the receive loop runs against injected
/// error sequences in tests.
pub(super) trait DiscoverySocket {
    fn announce(&self, payload: &[u8]);
    fn receive(&self, buf: &mut [u8]) -> std::io::Result<(usize, std::net::SocketAddr)>;
}

impl DiscoverySocket for std::net::UdpSocket {
    fn announce(&self, payload: &[u8]) {
        let _ = self.send_to(payload, (std::net::Ipv4Addr::BROADCAST, DISCOVERY_PORT));
    }
    fn receive(&self, buf: &mut [u8]) -> std::io::Result<(usize, std::net::SocketAddr)> {
        self.recv_from(buf)
    }
}

const DISCOVERY_ANNOUNCE_EVERY: Duration = Duration::from_secs(2);
const DISCOVERY_ERROR_PAUSE_MIN: Duration = Duration::from_millis(10);
pub(super) const DISCOVERY_ERROR_PAUSE_MAX: Duration = Duration::from_secs(1);

/// Pause before the next receive after `consecutive` receive errors.
///
/// A receive error never ends discovery: Windows reports an oversized datagram
/// (WSAEMSGSIZE, 10040) or an ICMP port-unreachable reply to an earlier
/// broadcast (WSAECONNRESET, 10054) as a receive error on a healthy socket.
/// The pause doubles per consecutive error up to one second, so a persistent
/// error costs at most one wakeup per second instead of a busy loop.
fn discovery_error_pause(consecutive: u32) -> Duration {
    DISCOVERY_ERROR_PAUSE_MIN
        .saturating_mul(1u32 << consecutive.saturating_sub(1).min(16))
        .min(DISCOVERY_ERROR_PAUSE_MAX)
}

/// Sleep in short slices so `sync_discovery_stop`, which joins this thread
/// while holding the discovery lock, never waits out a whole back-off pause.
pub(super) fn pause_while_running(running: &AtomicBool, pause: Duration) {
    const SLICE: Duration = Duration::from_millis(50);
    let until = Instant::now() + pause;
    while running.load(Ordering::Relaxed) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left.min(SLICE));
    }
}

pub(super) fn run_discovery_loop(
    socket: &impl DiscoverySocket,
    running: &AtomicBool,
    payload: &[u8],
    mut filter: DiscoveryFilter,
    mut emit: impl FnMut(DiscoveryPacket),
    mut pause: impl FnMut(Duration),
) {
    let mut last_announce: Option<Instant> = None;
    let mut buf = [0u8; 4096];
    let mut consecutive_errors = 0u32;
    while running.load(Ordering::Relaxed) {
        if last_announce.is_none_or(|at| at.elapsed() >= DISCOVERY_ANNOUNCE_EVERY) {
            socket.announce(payload);
            last_announce = Some(Instant::now());
        }
        match socket.receive(&mut buf) {
            Ok((n, from)) => {
                consecutive_errors = 0;
                let Ok(packet) = serde_json::from_slice::<DiscoveryPacket>(&buf[..n]) else {
                    continue;
                };
                if let Some(packet) = filter.admit(packet, from.ip(), Instant::now()) {
                    emit(packet);
                }
            }
            // The socket's read timeout paces an idle loop.
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                consecutive_errors = 0;
            }
            Err(_) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                pause(discovery_error_pause(consecutive_errors));
            }
        }
    }
}

/// Received announcements become at most one event per device per refresh
/// interval, plus changes. The reply address is the packet source, never the
/// advertised host, so a LAN sender cannot point Mesa at another machine.
pub(super) struct DiscoveryFilter {
    own_fingerprint: String,
    seen: HashMap<String, (Instant, DiscoveryPacket)>,
    window_start: Option<Instant>,
    window_emits: usize,
}

const DISCOVERY_REFRESH: Duration = Duration::from_secs(5);
const DISCOVERY_FORGET: Duration = Duration::from_secs(20);
const DISCOVERY_MAX_DEVICES: usize = 64;
pub(super) const DISCOVERY_MAX_EMITS_PER_SECOND: usize = 16;

impl DiscoveryFilter {
    pub(super) fn new(own_fingerprint: String) -> Self {
        Self {
            own_fingerprint,
            seen: HashMap::new(),
            window_start: None,
            window_emits: 0,
        }
    }

    pub(super) fn admit(
        &mut self,
        mut packet: DiscoveryPacket,
        from: IpAddr,
        now: Instant,
    ) -> Option<DiscoveryPacket> {
        if !packet.mesa_discovery
            || packet.fingerprint == self.own_fingerprint
            || packet.fingerprint.len() != 64
            || !packet
                .fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || packet.name.len() > 256
        {
            return None;
        }
        packet.host = from.to_string();
        if let Some((at, previous)) = self.seen.get(&packet.fingerprint) {
            let unchanged = previous.host == packet.host
                && previous.port == packet.port
                && previous.name == packet.name
                && previous.listening == packet.listening
                && previous.protocol == packet.protocol
                && previous.version == packet.version;
            if unchanged && now.duration_since(*at) < DISCOVERY_REFRESH {
                return None;
            }
        } else if self.seen.len() >= DISCOVERY_MAX_DEVICES {
            self.seen
                .retain(|_, (at, _)| now.duration_since(*at) < DISCOVERY_FORGET);
            if self.seen.len() >= DISCOVERY_MAX_DEVICES {
                return None;
            }
        }
        match self.window_start {
            Some(start) if now.duration_since(start) < Duration::from_secs(1) => {
                if self.window_emits >= DISCOVERY_MAX_EMITS_PER_SECOND {
                    return None;
                }
            }
            _ => {
                self.window_start = Some(now);
                self.window_emits = 0;
            }
        }
        self.window_emits += 1;
        self.seen
            .insert(packet.fingerprint.clone(), (now, packet.clone()));
        Some(packet)
    }
}

// Blocking work: run off the main (UI) thread.
#[tauri::command(async)]
pub fn sync_discovery_stop() -> Result<(), String> {
    let mut guard = discovery_state().lock().map_err(|e| e.to_string())?;
    if let Some(mut st) = guard.take() {
        st.running.store(false, Ordering::Relaxed);
        if let Some(h) = st.handle.take() {
            let _ = h.join();
        }
    }
    Ok(())
}
