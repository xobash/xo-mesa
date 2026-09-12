import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import { getMesaPerfTimeline } from "../lib/mesaPerf";
import { isIndexedCache, workingSetStats } from "../lib/documentWorkingSet";
import { activePdfPerfRun } from "./pdfPerf";
import { Modal } from "./Modal";
import { backgroundWork } from "../lib/backgroundWorkGovernor";
import { clearLocalIndexCache, vaultIndexStorageStats, type VaultIndexStorageStats } from "../lib/vaultIndex";
import { recordResourceSample, summarizeResourcePlateau } from "../lib/resourcePlateau";
import { sampleProcessTreeResources, type ProcessTreeRateSample } from "../lib/processResources";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function count(n: number): string {
  return n.toLocaleString();
}

function latestDuration(events: ReturnType<typeof getMesaPerfTimeline>["events"], startName: string, endName: string): number | undefined {
  const end = [...events].reverse().find((event) => event.name === endName);
  if (!end) return undefined;
  const start = [...events].reverse().find((event) => event.name === startName && event.at <= end.at);
  return start ? end.at - start.at : undefined;
}

export function DiagnosticsModal() {
  const open = useAppStore((s) => s.diagnosticsOpen);
  const setOpen = useAppStore((s) => s.setDiagnosticsOpen);
  const vaultName = useAppStore((s) => s.vaultName);
  const files = useAppStore((s) => s.files);
  const notes = useAppStore((s) => s.notes);
  const cache = useAppStore((s) => s.contentCache);
  const indexingTextFiles = useAppStore((s) => s.indexingTextFiles);
  const unindexedTextFiles = useAppStore((s) => s.unindexedTextFiles);
  const syncBusy = useAppStore((s) => s.syncBusy);
  const syncProgress = useAppStore((s) => s.syncProgress);
  const syncLog = useAppStore((s) => s.syncLog);
  const textSaveState = useAppStore((s) => s.textSaveState);
  const loading = useAppStore((s) => s.loading);
  const deepResearch = useAppStore((s) => s.deepResearch);
  const [tick, setTick] = useState(0);
  const [storage, setStorage] = useState<VaultIndexStorageStats | null>(null);
  const [processTree, setProcessTree] = useState<ProcessTreeRateSample | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void vaultIndexStorageStats().then(setStorage);
  }, [open, tick]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void sampleProcessTreeResources()
      .then((sample) => {
        if (!disposed) setProcessTree(sample);
      })
      .catch(() => {
        if (!disposed) setProcessTree(null);
      });
    return () => {
      disposed = true;
    };
  }, [open, tick]);

  const snapshot = useMemo(() => {
    const timeline = getMesaPerfTimeline();
    const working = workingSetStats(cache);
    const markdown = files.filter((file) => file.isMarkdown).length;
    const cached = Object.keys(cache).length;
    const indexed = isIndexedCache(cache);
    const latest = timeline.events.slice(-12).reverse();
    const lastVaultReady = [...timeline.events].reverse().find((event) => event.name === "vault-ready");
    const lastLongTask = [...timeline.events].reverse().find((event) => event.name === "long-task");
    const lastFileReadyIndex = timeline.events.map((event) => event.name).lastIndexOf("file-open-ready");
    const lastFileRequest = lastFileReadyIndex >= 0
      ? [...timeline.events.slice(0, lastFileReadyIndex)].reverse().find((event) => event.name === "file-open-requested")
      : undefined;
    const fileOpenMs = lastFileReadyIndex >= 0 && lastFileRequest
      ? timeline.events[lastFileReadyIndex].at - lastFileRequest.at
      : undefined;
    const lastWatcherBatch = [...timeline.events].reverse().find((event) => event.name === "watcher-batch");
    const vaultOpenMs = latestDuration(timeline.events, "vault-open-requested", "vault-ready");
    const vaultScan = [...timeline.events].reverse().find((event) => event.name === "vault-scan-complete");
    const vaultOpen = [...timeline.events].reverse().find((event) => event.name === "vault-scan-start");
    const searchMs = latestDuration(timeline.events, "search-start", "search-complete");
    const syncMs = latestDuration(timeline.events, "sync-start", "sync-complete");
    const activeJobs = [
      loading && "vault open",
      indexingTextFiles > 0 && `indexing ${count(indexingTextFiles)} files`,
      syncBusy && "sync",
      textSaveState.pending > 0 && `saving ${count(textSaveState.pending)} edits`,
      deepResearch && deepResearch.phase !== "idle" && `research (${deepResearch.phase})`,
    ].filter((job): job is string => Boolean(job));
    const pdfRun = activePdfPerfRun();
    const governor = backgroundWork.snapshot();
    const resourceSample = recordResourceSample({
      nowMs: Date.now(),
      working,
      governor,
      activeJobs: activeJobs.length,
      pdfRasterBytes: pdfRun?.counters.rasterBytes ?? 0,
    });
    const resourcePlateau = summarizeResourcePlateau();
    const queuedWork = Object.entries(governor.byKind)
      .filter(([, value]) => value && (value.active || value.queued))
      .map(([kind, value]) => `${kind} ${value!.active ? `${value!.active} running` : ""}${value!.active && value!.queued ? ", " : ""}${value!.queued ? `${value!.queued} queued` : ""}`)
      .join(" · ");
    const health = loading
      ? "Mesa is opening the vault. You can keep this window open while it finishes."
      : lastLongTask && Number(lastLongTask.detail?.durationMs ?? 0) >= 100
        ? `Mesa recently paused for ${lastLongTask.detail?.durationMs} ms. Recent marks below identify the work in progress.`
        : vaultOpen?.detail?.rootKind === "remote-hint" && vaultOpenMs !== undefined && vaultOpenMs >= 500
          ? "This vault appears to be remote or removable; storage access is the likely open-time limit."
          : governor.pressure !== "idle"
            ? "Mesa is yielding background work to keep typing and navigation responsive."
            : unindexedTextFiles
              ? `${count(unindexedTextFiles)} large text files are search-by-name only to protect responsiveness.`
              : "Mesa is responsive. No current local pressure signal needs attention.";
    return {
      timeline,
      latest,
      lastVaultReady,
      lastLongTask,
      fileOpenMs,
      lastWatcherBatch,
      vaultOpenMs,
      searchMs,
      syncMs,
      activeJobs,
      pdfRun,
      resourceSample,
      resourcePlateau,
      working,
      markdown,
      cached,
      indexed,
      governor,
      queuedWork,
      health,
      vaultScan,
    };
  }, [cache, files, tick]);

  if (!open) return null;

  const syncLabel = syncBusy
    ? syncProgress
      ? `${syncProgress.phase} ${syncProgress.done}/${syncProgress.total}`
      : "running"
    : "idle";

  return (
    <Modal onClose={() => setOpen(false)} className="diagnostics" title="Diagnostics">
      <header className="modal-head">
        <span>Diagnostics</span>
        <div className="modal-head-actions">
          <button className="btn" onClick={() => setTick((n) => n + 1)}>Refresh</button>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">×</button>
        </div>
      </header>
      <div className="settings-body diag-body">
        <section className="diag-grid" aria-label="Diagnostics summary">
          <div className="diag-card">
            <span className="diag-label">Vault</span>
            <strong>{vaultName || "none"}</strong>
            <span>{count(files.length)} files · {count(Object.keys(notes).length)} notes</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Index</span>
            <strong>{snapshot.indexed ? "compressed" : "plain"}</strong>
            <span>{count(snapshot.cached)} cached · {count(indexingTextFiles)} still indexing</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Decoded Text</span>
            <strong>{bytes(snapshot.working.decodedChars * 2)}</strong>
            <span>{count(snapshot.working.decodedDocuments)} documents in memory</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Sync</span>
            <strong>{syncLabel}</strong>
            <span>{count(syncLog.length)} log lines</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Saves</span>
            <strong>{textSaveState.failed ? "needs attention" : "clear"}</strong>
            <span>{textSaveState.pending} pending · {textSaveState.saving} saving</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Search Coverage</span>
            <strong>{unindexedTextFiles ? "partial" : "full"}</strong>
            <span>{count(unindexedTextFiles)} large files name-only</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Background Work</span>
            <strong>{snapshot.activeJobs.length ? `${count(snapshot.activeJobs.length)} active` : "idle"} · {snapshot.governor.queued} queued</strong>
            <span>{snapshot.governor.pressure === "interactive" ? `Paused for input${snapshot.queuedWork ? ` · ${snapshot.queuedWork}` : ""}` : `${snapshot.governor.limit} work slots · ${snapshot.queuedWork || snapshot.activeJobs.join(" · ") || "No active jobs"}`}</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">PDF Memory</span>
            <strong>{snapshot.pdfRun ? "active" : "idle"}</strong>
            <span>{snapshot.pdfRun ? `${snapshot.pdfRun.file.relPath} · ${count(snapshot.pdfRun.counters.pagesPlanned ?? 0)} pages planned · ~${bytes(snapshot.pdfRun.counters.rasterBytes ?? 0)} raster memory` : "No PDF run recorded"}</span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Resource Plateau</span>
            <strong>{snapshot.resourcePlateau?.trend ?? "warming"}</strong>
            <span>
              {snapshot.resourceSample.heapBytes === null
                ? "Renderer heap unavailable"
                : `heap ${bytes(snapshot.resourceSample.heapBytes)}`}
              {snapshot.resourcePlateau ? ` · ${snapshot.resourcePlateau.samples} samples` : ""}
            </span>
          </div>
          <div className="diag-card">
            <span className="diag-label">Process Tree</span>
            <strong>{processTree ? bytes(processTree.rssBytes) : "native only"}</strong>
            <span>
              {processTree
                ? `${count(processTree.processCount)} processes${processTree.cpuPercent === null ? "" : ` · ${processTree.cpuPercent.toFixed(1)}% CPU`}`
                : "Open in Mesa to sample OS resources"}
            </span>
          </div>
        </section>
        <section className="diag-section">
          <h3>What Mesa sees</h3>
          <p className="setting-desc">{snapshot.health}</p>
          {snapshot.vaultScan && <p className="setting-desc">Last vault listing found {count(Number(snapshot.vaultScan.detail?.files ?? 0))} files. These details stay on this device.</p>}
        </section>
        <section className="diag-section">
          <h3>Local Cache</h3>
          <div className="diag-timeline">
            <span>{storage ? `${bytes(storage.bytes)} of ${bytes(storage.budgetBytes)} · ${storage.snapshots} vault snapshot${storage.snapshots === 1 ? "" : "s"}` : "Measuring cache…"}</span>
            <button className="btn" onClick={() => void clearLocalIndexCache().then(() => setTick((n) => n + 1))}>Clear local cache</button>
          </div>
          <span className="setting-desc">Removes disposable indexes only. Your vault files and settings stay untouched.</span>
        </section>
        <section className="diag-section">
          <h3>Resource Trend</h3>
          <div className="diag-timeline">
            {snapshot.resourcePlateau ? (
              <>
                {snapshot.resourcePlateau.heapDeltaBytes !== null && (
                  <span>Renderer heap delta: {bytes(Math.abs(snapshot.resourcePlateau.heapDeltaBytes))} {snapshot.resourcePlateau.heapDeltaBytes >= 0 ? "up" : "down"}</span>
                )}
                <span>Decoded text delta: {bytes(Math.abs(snapshot.resourcePlateau.decodedDeltaBytes))} {snapshot.resourcePlateau.decodedDeltaBytes >= 0 ? "up" : "down"}</span>
                <span>PDF raster delta: {bytes(Math.abs(snapshot.resourcePlateau.pdfRasterDeltaBytes))} {snapshot.resourcePlateau.pdfRasterDeltaBytes >= 0 ? "up" : "down"}</span>
                <span>Queue delta: {snapshot.resourcePlateau.queuedDelta}</span>
                {processTree && (
                  <span>
                    Process tree: {bytes(processTree.rssBytes)}
                    {processTree.cpuPercent === null ? "" : ` · ${processTree.cpuPercent.toFixed(1)}% CPU`}
                  </span>
                )}
              </>
            ) : (
              <span>Collecting local resource samples…</span>
            )}
          </div>
          <span className="setting-desc">
            Renderer samples show owned caches; native Mesa adds OS process-tree RSS and CPU when available.
          </span>
          {processTree?.unsupportedReason && <span className="setting-desc">{processTree.unsupportedReason}</span>}
        </section>
        <section className="diag-section">
          <h3>Vault Open</h3>
          <div className="diag-timeline">
            {snapshot.lastVaultReady ? (
              <span>Last ready at {snapshot.lastVaultReady.at.toFixed(1)} ms{snapshot.vaultOpenMs !== undefined ? ` · open took ${snapshot.vaultOpenMs.toFixed(1)} ms` : ""}</span>
            ) : (
              <span>No vault-ready mark yet</span>
            )}
            <span>{count(snapshot.markdown)} Markdown files on the note path</span>
          </div>
        </section>
        <section className="diag-section">
          <h3>Responsiveness</h3>
          <div className="diag-timeline">
            {snapshot.lastLongTask ? (
              <span>Last long task: {String(snapshot.lastLongTask.detail?.durationMs ?? "?")} ms</span>
            ) : (
              <span>No long tasks observed in this session</span>
            )}
            {snapshot.fileOpenMs !== undefined && <span>Last file switch: {snapshot.fileOpenMs.toFixed(1)} ms</span>}
            {snapshot.searchMs !== undefined && <span>Last search pass: {snapshot.searchMs.toFixed(1)} ms</span>}
            {snapshot.syncMs !== undefined && <span>Last sync: {snapshot.syncMs.toFixed(1)} ms</span>}
            {snapshot.lastWatcherBatch && (
              <span>Last watcher burst: {String(snapshot.lastWatcherBatch.detail?.events ?? "?")} events</span>
            )}
          </div>
        </section>
        <section className="diag-section">
          <h3>Recent Marks</h3>
          <div className="diag-marks">
            {snapshot.latest.length ? snapshot.latest.map((event) => (
              <div className="diag-mark" key={`${event.name}-${event.at}`}>
                <span>{event.name}</span>
                <time>{event.at.toFixed(1)} ms</time>
              </div>
            )) : <span className="setting-desc">No local marks recorded yet.</span>}
          </div>
        </section>
      </div>
    </Modal>
  );
}
