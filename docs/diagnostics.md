# Diagnostics

Mesa includes a local diagnostics window for performance and app-health checks.
Open it from the top bar diagnostics button.

## Background-work governor

Diagnostics shows the shared background queue, its current concurrency, and
whether it is paused for input. Index hydration, thumbnail rendering, sync
admission, watcher recovery, and research admission share this local governor.
Typing, scrolling, dragging, PDF gestures, and resize activity temporarily
give foreground work priority. The displayed data stays in memory on this
device; it is not telemetry.
Queued work that owns a cancellation handle, such as outgoing sync admission,
can remove its pending job before it starts. Cancellation of work already in
flight remains the caller's responsibility.

While open, the view refreshes once per second so long tasks, watcher bursts,
file switches, and background-job changes appear without a manual refresh.
Persistent cache accounting is deliberately different: Mesa reads a compact
per-vault metadata index when the panel opens or the user presses Refresh. It
never reads cached document bodies merely to display a byte total.

## What It Shows

- Vault size: file and note counts.
- Search/index state: compressed versus plain cache, cached text count,
  still-indexing files, and large text files that are name-only in search.
- Decoded text pressure: current decoded working-set size and document count.
- Sync state: idle/running state, progress phase, and retained sync log count.
- Save health: pending, active, and failed verified writes.
- Background work: active vault opening, indexing, sync, save, and research
  jobs, with their current count and short labels.
- PDF activity: the active PDF run, planned page count, and estimated raster
  memory for painted canvases. This is a workload indicator, not a process heap
  reading.
- Resource plateau: a bounded local sample ring for renderer heap when exposed
  by the webview, decoded text, queued background work, active jobs, and PDF
  raster memory. It reports warming, incomplete, plateau, or growing. Plateau
  requires valid renderer heap data throughout the sample window; missing heap
  data cannot establish stability. Growth in an owned resource can still be shown.
- Process tree: in the native app, Mesa samples its own process plus child
  processes once per refresh and shows resident memory, process count, and CPU
  rate when the host exposes enough timing data. Overlapping refreshes share
  one request. Windows uses a direct Toolhelp/process-handle sample, not a
  PowerShell or WMI subprocess. This is read-only and local-only; it is the
  partial resource signal. It does not establish complete shared WebKit or GPU
  coverage. CPU rates are unavailable when sampled process membership changes.
  Renderer samples explain which Mesa-owned caches are changing.
- Recent performance marks: bounded renderer-local marks such as vault scan,
  Markdown completion, vault ready, search completion, and document visibility.
- Responsiveness: the most recent browser-observed long task, when the host
  supports the Long Tasks API. This is a local observation, not a diagnosis.
- Watcher pressure: the size of the most recent coalesced filesystem event
  batch, when one occurred during the session.
- File switching: the latest request-to-ready duration recorded by the store.
- A plain-language local health summary. It identifies an active open, a
  browser-observed long task, remote/removable vault pressure, background work
  yielding for input, or deliberately name-only large text files. It is a
  guide to the next investigation, not a claim about total process memory.

## Privacy Boundary

Diagnostics are local-only. They do not send telemetry, persist a report, or
show absolute vault paths. The performance timeline is an in-memory renderer
ring capped at 256 events. Native process-tree sampling reads only OS process
IDs, parent IDs, resident memory, and CPU time for the current Mesa tree.

## Cross-Platform Use

Use diagnostics during native acceptance, especially on Windows. Windows pays
more for IPC round trips and Tauri events because WebView2 dispatches them on
the UI thread. During a run, watch for:

- delayed vault-ready timing after scan or Markdown completion,
- background indexing that stays nonzero while typing,
- decoded text pressure that grows without settling,
- process-tree memory or CPU that climbs after repeated open/close cycles,
- sync progress or log counts that advance in tiny bursts instead of batches,
- save failures caused by locked files, synced folders, or antivirus scans.

Browser and Node checks are useful for regression coverage, but they do not
prove native macOS or physical Windows performance.

## Mixed workload recordings

Start a recording, close Diagnostics, and type while the work under test runs.
Reopen Diagnostics to stop it. The table shows input count, median, and 95th
percentile for each observed workload; zero samples means untested. Copy
measurements includes the raw local samples and resource coverage. Recording
stops after ten minutes and caps input samples at 6,000. It records no document
text, keystrokes, or paths. Closing the app discards the recording.

Input timing measures the event timestamp to the second animation frame, a
paint-opportunity proxy rather than OS input-to-photon latency. Hidden-window
inputs and cancelled frame callbacks are counted separately. Workload flags
reflect the input's context; a visible PDF editor does not prove PDF CPU work
was active at that instant. Detached-window count is sampled at recording start.
Record separately in each window and retain native OS measurements alongside
these renderer results before changing resource controls.
