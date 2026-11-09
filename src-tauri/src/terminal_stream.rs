// Pi PTY output: UTF-8 decoding across reads, the bounded sequenced history
// used for snapshot and gapless reattach, and the coalescing reader/flusher
// hand-off. Part of `terminal`.

use super::*;

pub(super) const TERMINAL_HISTORY_MAX_BYTES: usize = 4 * 1024 * 1024;
pub(super) const TERMINAL_RESIZE_HISTORY_COST: usize = 4;

/// Output coalescing interval. Batch PTY reads to limit webview event work;
/// flush_delay emits the first output after a quiet interval immediately.
pub(super) const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Emit early once a batch reaches this size instead of growing one enormous JS
/// source string. The eval is parsed and compiled in a single go, so an
/// unbounded payload would trade many short stalls for one long one.
pub(super) const OUTPUT_FLUSH_MAX_BYTES: usize = 64 * 1024;

/// Hard ceiling for decoded output waiting behind a slow webview consumer.
/// Once reached, the reader waits on the same condvar until the flusher drains
/// an event. This applies backpressure to the PTY without dropping bytes or
/// allowing a Windows UI-thread stall to grow the Rust heap without bound.
pub(super) const OUTPUT_PENDING_MAX_BYTES: usize = 1024 * 1024;

/// The PTY history plus the coalescing pump's wakeup channel.
///
/// One mutex guards staged bytes, committed entries, and resize markers so they
/// cannot interleave out of order, and the condvar lets the reader thread wake
/// the flusher without polling — an idle Pi session costs zero wakeups.
pub(super) struct TerminalStream {
    pub(super) history: Mutex<TerminalHistory>,
    pub(super) wake: Condvar,
}

impl TerminalStream {
    pub(super) fn new(history: TerminalHistory) -> Self {
        Self {
            history: Mutex::new(history),
            wake: Condvar::new(),
        }
    }

    /// A panicked reader/flusher thread must not be able to brick Pi's output,
    /// resize, or replay, so poisoning is recovered from rather than surfaced.
    pub(super) fn lock(&self) -> MutexGuard<'_, TerminalHistory> {
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Wake the flusher when opening a batch or crossing its size cap, not on every staged read.
    pub(super) fn stage(&self, data: &str) {
        if data.is_empty() {
            return;
        }
        let mut history = self.lock();
        while history.pending.len() >= OUTPUT_PENDING_MAX_BYTES && !history.closed {
            history = self
                .wake
                .wait(history)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        if history.closed {
            return;
        }
        let opened_batch = history.pending.is_empty();
        history.stage_output(data);
        let notify = opened_batch || history.pending.len() >= OUTPUT_FLUSH_MAX_BYTES;
        drop(history);
        if notify {
            self.wake.notify_all();
        }
    }

    /// Record EOF. The flusher emits whatever is left, then exits.
    pub(super) fn close(&self, tail: &str) {
        let mut history = self.lock();
        history.stage_output(tail);
        history.closed = true;
        drop(history);
        self.wake.notify_all();
    }
}

#[derive(Default)]
pub(super) struct TerminalHistory {
    pub(super) entries: VecDeque<TerminalHistoryEntry>,
    pub(super) bytes: usize,
    pub(super) seq: u64,
    /// Decoded bytes read from the PTY that are not committed yet. They are
    /// invisible to `snapshot`/`replay` until `commit_pending` runs, so a
    /// resize marker can never be recorded between a read and its own entry.
    pub(super) pending: String,
    /// Committed chunks whose `terminal://output` event has not been sent yet.
    /// Only the flusher thread drains this, which keeps emission
    /// single-threaded and in `seq` order even when a resize is what forced the
    /// commit.
    pub(super) outbox: VecDeque<(String, u64)>,
    /// When the last commit happened, for the leading-edge rule in
    /// `flush_delay`. `None` means nothing has been emitted yet.
    pub(super) last_flush: Option<Instant>,
    /// The reader thread hit EOF; the flusher returns once `outbox` drains.
    pub(super) closed: bool,
}

pub(super) enum TerminalHistoryEntry {
    Output(String),
    Resize { rows: u16, cols: u16 },
}

impl TerminalHistory {
    pub(super) fn trim(&mut self) {
        while self.bytes > TERMINAL_HISTORY_MAX_BYTES && self.entries.len() > 1 {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes = self.bytes.saturating_sub(match removed {
                    TerminalHistoryEntry::Output(data) => data.len(),
                    TerminalHistoryEntry::Resize { .. } => TERMINAL_RESIZE_HISTORY_COST,
                });
            }
        }
    }

    pub(super) fn push_output(&mut self, data: String) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.bytes += data.len();
        self.entries.push_back(TerminalHistoryEntry::Output(data));
        self.trim();
        self.seq
    }

    /// Hold decoded bytes back until the pump decides to emit them.
    pub(super) fn stage_output(&mut self, data: &str) {
        self.pending.push_str(data);
    }

    /// Flush immediately at the size cap or after a quiet interval; otherwise wait for the batch deadline.
    pub(super) fn flush_delay(&self, now: Instant) -> Duration {
        if self.pending.is_empty() {
            return OUTPUT_FLUSH_INTERVAL;
        }
        if self.pending.len() >= OUTPUT_FLUSH_MAX_BYTES {
            return Duration::ZERO;
        }
        match self.last_flush {
            None => Duration::ZERO,
            Some(last) => OUTPUT_FLUSH_INTERVAL.saturating_sub(now.saturating_duration_since(last)),
        }
    }

    /// Commit at most OUTPUT_FLUSH_MAX_BYTES per history entry; leave remaining bytes ready to drain.
    pub(super) fn commit_pending(&mut self, now: Instant) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        let data = if self.pending.len() <= OUTPUT_FLUSH_MAX_BYTES {
            std::mem::take(&mut self.pending)
        } else {
            // Splitting inside a multi-byte character would panic here, and
            // would reach xterm as replacement characters that widen the line
            // — the same double-render failure `Utf8Stream` prevents at the
            // read boundary. Back up to the nearest boundary (at most 3 bytes).
            let mut cut = OUTPUT_FLUSH_MAX_BYTES;
            while !self.pending.is_char_boundary(cut) {
                cut -= 1;
            }
            let rest = self.pending.split_off(cut);
            std::mem::replace(&mut self.pending, rest)
        };
        let seq = self.push_output(data.clone());
        self.outbox.push_back((data, seq));
        self.last_flush = Some(now);
        true
    }

    pub(super) fn push_resize(&mut self, rows: u16, cols: u16) -> u64 {
        // Staged bytes were produced *before* this resize. Committing them
        // first is what keeps `replay()`'s grid timeline honest: replaying
        // pre-resize TUI bytes at the post-resize width re-wraps lines and
        // strands Pi's cursor-up rewrites — the same failure `Utf8Stream`
        // documents above.
        self.commit_pending(Instant::now());
        self.seq = self.seq.saturating_add(1);
        self.bytes += TERMINAL_RESIZE_HISTORY_COST;
        self.entries
            .push_back(TerminalHistoryEntry::Resize { rows, cols });
        self.trim();
        self.seq
    }

    pub(super) fn snapshot(&self) -> String {
        self.entries
            .iter()
            .filter_map(|entry| match entry {
                TerminalHistoryEntry::Output(data) => Some(data.as_str()),
                TerminalHistoryEntry::Resize { .. } => None,
            })
            .collect()
    }

    pub(super) fn replay(&self) -> Vec<TerminalReplayEvent> {
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

#[derive(Serialize)]
pub struct TerminalReplayEvent {
    pub(super) kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cols: Option<u16>,
}

/// Carry at most three trailing UTF-8 bytes across PTY reads; replace incomplete tails only at EOF.
#[derive(Default)]
pub(super) struct Utf8Stream {
    pub(super) carry: Vec<u8>,
}

impl Utf8Stream {
    /// Decode `chunk`, prefixed by any tail held back from the previous read.
    /// Genuinely invalid bytes still become U+FFFD, matching `from_utf8_lossy`;
    /// only *truncated* sequences are deferred.
    pub(super) fn push(&mut self, chunk: &[u8]) -> String {
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
    pub(super) fn flush(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        self.carry.clear();
        char::REPLACEMENT_CHARACTER.to_string()
    }
}

/// The reader stages decoded output; the flusher emits it. Only the bounded pending queue applies backpressure.
pub(super) fn spawn_reader<R>(mut reader: R, stream: Arc<TerminalStream>)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name("mesa-terminal-reader".to_string())
        .spawn(move || {
            let mut buf = [0u8; 4096];
            let mut decoder = Utf8Stream::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => stream.stage(&decoder.push(&buf[..n])),
                    Err(_) => break,
                }
            }
            stream.close(&decoder.flush());
        });
}

/// Wait for due output. Return an empty batch once after reader closure and complete drain.
pub(super) fn next_output_batch(stream: &TerminalStream) -> Vec<(String, u64)> {
    let mut history = stream.lock();
    loop {
        if !history.outbox.is_empty() {
            break;
        }
        if !history.pending.is_empty() {
            let now = Instant::now();
            // At EOF there is nothing left to coalesce with, so the tail goes
            // out immediately rather than paying one last window.
            let delay = if history.closed {
                Duration::ZERO
            } else {
                history.flush_delay(now)
            };
            if delay.is_zero() {
                history.commit_pending(now);
                break;
            }
            let (guard, _) = stream
                .wake
                .wait_timeout(history, delay)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            history = guard;
            continue;
        }
        if history.closed {
            return Vec::new();
        }
        history = stream
            .wake
            .wait(history)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    let batch: Vec<_> = history.outbox.drain(..).collect();
    drop(history);
    // A reader may be blocked at OUTPUT_PENDING_MAX_BYTES. Wake it after the
    // committed event leaves the staging queue, before the caller emits the
    // event to the webview.
    stream.wake.notify_all();
    batch
}
