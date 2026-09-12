import { useDeferredValue, useMemo } from "react";
import { useAppStore } from "../store";
import { backlinksFor } from "../lib/graph";
import { SORT_LABELS } from "../lib/sort";
import { countWords } from "../lib/wordCount";

export function StatusBar() {
  const activePath = useAppStore((s) => s.activePath);
  const content = useAppStore((s) => s.content);
  const notes = useAppStore((s) => s.notes);
  const files = useAppStore((s) => s.files);
  const sortMode = useAppStore((s) => s.settings.sortMode);
  const syncListening = useAppStore((s) => s.syncListening);
  const linkCount = useAppStore((s) => s.openTabs.length);
  const status = useAppStore((s) => s.status);
  const settingsIssue = useAppStore((s) => s.settingsIssue);
  const retrySettings = useAppStore((s) => s.retrySettings);
  const saveState = useAppStore((s) => s.textSaveState);
  const textSaveIssues = useAppStore((s) => s.textSaveIssues);
  const retryTextSaveIssue = useAppStore((s) => s.retryTextSaveIssue);
  const useDiskTextForSaveIssue = useAppStore(
    (s) => s.useDiskTextForSaveIssue
  );

  // This bar subscribes to the live editor text, so everything derived from it
  // runs per keystroke. Even the allocation-free `countWords` scan is O(note):
  // 6.2 ms per keystroke on a real 420 kB note, inside the keystroke's own
  // commit. Deriving the word/char pair from a DEFERRED copy of the text moves
  // that scan to transition priority — the keystroke paints first, and under
  // sustained typing React discards stale transitions instead of queueing a
  // scan per character (same pattern as MarkdownView's deferred render). The
  // memo makes the transition render the only one that pays the scan. Both
  // numbers read the same deferred string so words/chars never disagree with
  // each other; the settled values are identical to the live ones. The asset
  // count is memoized because `files` does not change while typing (it changes
  // only on a vault scan or a create/delete), so filtering 4,000+ entries into
  // a throwaway array on every character was pure waste.
  const statsText = useDeferredValue(content);
  const words = useMemo(() => countWords(statsText), [statsText]);
  const backlinks = useMemo(
    () => (activePath ? backlinksFor(notes, activePath).length : 0),
    [notes, activePath]
  );
  // Memoized for the same reason as `assetCount` below: this bar re-renders on
  // every keystroke, but `notes` only churns on a debounced save (<=2 Hz), and
  // `Object.keys` materializes a throwaway array of every note key to read its
  // length — 63 us and 2,400 allocated entries per character on the measured
  // vault.
  const noteCount = useMemo(() => Object.keys(notes).length, [notes]);
  const assetCount = useMemo(
    () => files.reduce((n, f) => (f.isMarkdown ? n : n + 1), 0),
    [files]
  );
  const saveIssues = useMemo(
    () => Object.values(textSaveIssues),
    [textSaveIssues]
  );

  // The store's global `status` is the app's one transient message feed —
  // "Scanning vault…", "Imported 3 files", and every failure a background
  // path can hit ("Save failed: …", "Rename failed: …"). It was written by a
  // dozen paths and RENDERED BY NOTHING, so a failed save was silent: the
  // user closed the app not knowing their edit never reached disk. The bar
  // shows it here; failures get the danger color. The one value suppressed is
  // the post-open "N notes" summary, which duplicates the count at the left
  // edge of this same bar.
  const statusMsg = status && status !== `${noteCount} notes` ? status : "";
  const statusIsError = /failed|blocked|error/i.test(statusMsg);

  return (
    <footer className="statusbar">
      <span>{noteCount} notes</span>
      {assetCount > 0 && <span>{assetCount} assets</span>}
      {linkCount > 0 && <span>{linkCount} open</span>}
      <span className="sb-sort">sort: {SORT_LABELS[sortMode].toLowerCase()}</span>
      {activePath && <span className="sb-path">{activePath}</span>}
      {statusMsg && (
        <span
          className={"sb-status" + (statusIsError ? " err" : "")}
          role={statusIsError ? "alert" : "status"}
          title={statusMsg}
        >
          {statusMsg}
        </span>
      )}
      <span className="sb-save-state" role="status" aria-live="polite" aria-atomic="true">
        {saveState.failed > 0 ? "Text changes need attention"
          : saveState.saving > 0 ? "Saving text changes…"
          : saveState.pending > 0 ? "Unsaved text changes"
          : activePath ? "Text changes saved" : ""}
      </span>
      {saveIssues.length > 0 && (
        <details className="sb-save-issues">
          <summary
            aria-label={`${saveIssues.length} unsaved ${
              saveIssues.length === 1 ? "file" : "files"
            }. Show save recovery actions.`}
          >
            <span aria-hidden="true">⚠</span>{" "}
            {saveIssues.length} unsaved
          </summary>
          <div className="sb-save-issue-list" role="list">
            {saveIssues.map((issue) => (
              <div className="sb-save-issue" role="listitem" key={issue.key}>
                <div className="sb-save-copy">
                  <strong>{issue.relPath}</strong>
                  <span title={issue.message}>{issue.message}</span>
                </div>
                <button
                  type="button"
                  className="sb-save-action"
                  disabled={issue.busy !== null}
                  aria-label={`Retry saving ${issue.relPath}`}
                  onClick={() => void retryTextSaveIssue(issue.key)}
                >
                  {issue.busy === "retry" ? "Retrying…" : "Retry"}
                </button>
                <button
                  type="button"
                  className="sb-save-action danger"
                  disabled={issue.busy !== null}
                  aria-label={`Use disk copy of ${issue.relPath}`}
                  title="Replace unsaved changes after confirmation"
                  onClick={() => void useDiskTextForSaveIssue(issue.key)}
                >
                  {issue.busy === "disk" ? "Reading…" : "Use disk copy"}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
      {settingsIssue && <details className="sb-save-issues"><summary>Settings need attention</summary><div className="sb-save-issue-list"><span role="alert">{settingsIssue}</span><button className="sb-save-action" onClick={retrySettings}>Retry settings</button></div></details>}
      <span className="sb-spacer" />
      {syncListening && <span className="sb-sync">◉ sync on</span>}
      {activePath && (
        <>
          <span>{words.toLocaleString()} words</span>
          <span>{statsText.length.toLocaleString()} chars</span>
          <span>{backlinks} backlinks</span>
        </>
      )}
    </footer>
  );
}
