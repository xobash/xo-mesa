import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { useAppStore, getStore } from "../store";
import { MarkdownView } from "./MarkdownView";
import { TableEditor } from "./TableEditor";
import { isProseFile, languageFor } from "./editorSyntax";
import { delimiterForExt, detectDelimiter } from "../lib/delimitedTable";
import { extOf } from "../lib/vaultPaths";
import { atxHeading } from "../lib/markdownCode";
import { MAX_EDITABLE_TEXT_CHARS, MAX_TABLE_EDIT_CHARS } from "../lib/textCachePlan";
import { formatBytes } from "../lib/formatBytes";
import { focusEditorCommands, registerEditorCommands, type EditorCommandTarget } from "../lib/editorCommands";
import {
  joinWithLineBreaks,
  needsLineBreakTracking,
  restoreLineBreakRun,
  trackLineBreaks,
  updateLineBreaks,
  type LineBreak,
  type LineBreakEdit,
  type TrackedLineBreaks,
} from "../lib/lineEndings";

// Token colors are CSS variables (--syn-*) set per theme in styles/tokens.css, so the
// source view never falls back to CodeMirror's fixed default palette.
const themedHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--syn-heading)", fontWeight: "600" },
  { tag: [t.strong], color: "var(--syn-strong)", fontWeight: "600" },
  { tag: [t.emphasis], color: "var(--syn-strong)", fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-faint)" },
  { tag: [t.link, t.url], color: "var(--syn-link)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.punctuation], color: "var(--syn-mark)" },
  { tag: [t.monospace, t.string, t.special(t.string)], color: "var(--syn-code)" },
  { tag: [t.quote], color: "var(--text-dim)", fontStyle: "italic" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syn-tag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-attr)" },
  { tag: [t.keyword, t.operator, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.number, t.bool, t.atom, t.literal], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--text-faint)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: "var(--syn-link)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const editableCompartment = new Compartment();

// Only structural styling lives here; all colors come from CSS variables in
// the stylesheet (.cm-editor rules) so the editor follows the active theme.
const editorLayout = EditorView.theme({
  "&": { height: "100%", fontSize: "15px" },
  ".cm-scroller": { overflow: "auto" },
});

interface EditorActivityChange { snippet: string; lines: { added: number; removed: number }; tasksUnchanged: boolean }

function activityFromUpdate(update: Parameters<Parameters<typeof EditorView.updateListener.of>[0]>[0]): EditorActivityChange {
  let snippet = "";
  let added = 0;
  let removed = 0;
  let tasksUnchanged = true;
  update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const newText = inserted.toString();
    const oldText = update.startState.doc.sliceString(fromA, toA);
    if (snippet.length < 160) snippet += newText.slice(0, 160 - snippet.length);
    added += newText.split("\n").length;
    removed += oldText.split("\n").length;
    if (newText.includes("\n") || oldText.includes("\n")) tasksUnchanged = false;
    const oldLine = update.startState.doc.lineAt(fromA).text;
    const newLine = update.state.doc.lineAt(fromB).text;
    if (toA > update.startState.doc.lineAt(fromA).to || toB > update.state.doc.lineAt(fromB).to ||
        /\[[ xX]\]|```|~~~/.test(oldLine) || /\[[ xX]\]|```|~~~/.test(newLine)) tasksUnchanged = false;
  });
  return { snippet: snippet.trim(), lines: { added, removed }, tasksUnchanged };
}

// CodeMirror stores every line break as one "\n". For a file with any CR this
// field keeps the break each line had on disk, so the text handed to the save
// path rewrites only the breaks an edit touched (policy: lib/lineEndings.ts).
// LF files never carry it and pay nothing.
// Undo puts the removed lines back with their own breaks: history stores the
// removed run and replays it with the inverted change. `pos` is where the run
// is reinserted. When quick edits are grouped, history maps a later step's run
// through the earlier step's reinsertion at the same point; the earlier text
// comes first there, so the later run maps to after it (assoc 1).
const restoreLineBreaks = StateEffect.define<{ pos: number; breaks: readonly LineBreak[] }>({
  map: (value, mapping) => ({ pos: mapping.mapPos(value.pos, 1), breaks: value.breaks }),
});
const lineBreaksField = StateField.define<TrackedLineBreaks>({
  create: () => trackLineBreaks(""),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const old = tr.startState.doc;
      const edits: LineBreakEdit[] = [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        edits.push({ fromLine: old.lineAt(fromA).number, toLine: old.lineAt(toA).number, insertedBreaks: inserted.lines - 1 });
      });
      next = updateLineBreaks(next, edits);
    }
    for (const effect of tr.effects) {
      if (!effect.is(restoreLineBreaks)) continue;
      const line = tr.newDoc.lineAt(Math.min(effect.value.pos, tr.newDoc.length)).number;
      next = restoreLineBreakRun(next, line, effect.value.breaks);
    }
    return next;
  },
  provide: () => invertedEffects.of((tr) => {
    const tracked = tr.startState.field(lineBreaksField, false);
    if (!tracked || !tr.docChanged) return [];
    const old = tr.startState.doc;
    const effects: StateEffect<{ pos: number; breaks: readonly LineBreak[] }>[] = [];
    tr.changes.iterChanges((fromA, toA) => {
      const fromLine = old.lineAt(fromA).number;
      const toLine = old.lineAt(toA).number;
      if (toLine > fromLine) {
        effects.push(restoreLineBreaks.of({ pos: fromA, breaks: tracked.breaks.slice(fromLine - 1, toLine - 1) }));
      }
    });
    return effects;
  }),
});

/** The document as file text, with its original line breaks. */
function docText(state: EditorState): string {
  const tracked = state.field(lineBreaksField, false);
  if (!tracked) return state.sliceDoc();
  if (!tracked.odd) return state.doc.sliceString(0, state.doc.length, tracked.dominant);
  return joinWithLineBreaks(state.doc.iterLines(), tracked);
}

/** The editor accepts edits only for a loaded, valid file within the edit limit. */
function canEdit(activePath: string | null, state: string, text: string): boolean {
  return Boolean(activePath) && state === "ready" && text.length <= MAX_EDITABLE_TEXT_CHARS;
}

/** Extension of the active file, for language and toolbar choices. The
 *  catalog wins; an uncatalogued path uses its name; no document is prose. */
function editorExt(state: { activePath: string | null; fileFor: (rel: string) => { ext: string } | undefined }): string {
  if (!state.activePath) return "md";
  return state.fileFor(state.activePath)?.ext ?? extOf(state.activePath.split("/").pop() ?? "");
}

function activeExt(): string {
  return editorExt(getStore());
}

function makeState(doc: string, onUserEdit: (text: string, activity: EditorActivityChange) => void, editable = true, ext = activeExt()): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      ...(needsLineBreakTracking(doc) ? [lineBreaksField.init(() => trackLineBreaks(doc))] : []),
      basicSetup,
      // Find and replace (Mod-F) opens above the note, like other editors.
      search({ top: true }),
      languageFor(ext),
      syntaxHighlighting(themedHighlight),
      editorLayout,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": isProseFile(ext) ? "Note editor" : "Text editor", "aria-multiline": "true" }),
      editableCompartment.of(EditorView.editable.of(editable)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        onUserEdit(docText(u.state), activityFromUpdate(u));
      }),
    ],
  });
}

export function Editor() {
  const activePath = useAppStore((s) => s.activePath);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const content = useAppStore((s) => s.content);
  const activeContentState = useAppStore((s) => s.activeContentState);
  const loadActiveContent = useAppStore((s) => s.loadActiveContent);
  const ext = useAppStore(editorExt);
  const prose = isProseFile(ext);
  const extDelimiter = delimiterForExt(ext);
  const [tableView, setTableView] = useState(true);
  const showTable = extDelimiter !== null && tableView;
  // The table reads the file's own delimiter (e.g. `;` in European CSV) from a
  // bounded prefix; edits keep it. Raw view skips the check.
  const delimiter = showTable ? detectDelimiter(content, extDelimiter) : extDelimiter;
  const tooLarge = content.length > MAX_EDITABLE_TEXT_CHARS;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The exact string we last pushed into the store from a user edit. When the
  // store echoes it back through the `content` subscription, we can skip the
  // doc-swap effect, so a keystroke never serializes the whole document a
  // second time just to find that nothing changed.
  const lastEditorTextRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"source" | "live">("source");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [headings, setHeadings] = useState<Array<{ level: number; label: string; line: number }>>([]);
  useEffect(() => {
    // Keep the same empty array: a fresh `[]` is a state change, and this effect
    // runs on every keystroke while the outline is closed.
    if (!outlineOpen || activeContentState !== "ready") { setHeadings((current) => current.length ? [] : current); return; }
    // The full outline is optional work. Run after the input event and coalesce
    // rapid edits instead of scanning the whole document in the render path.
    const timer = setTimeout(() => setHeadings(content.split("\n").flatMap((line, index) => {
      const heading = atxHeading(line);
      return heading ? [{ ...heading, line: index + 1 }] : [];
    })), 80);
    return () => clearTimeout(timer);
  }, [content, outlineOpen, activeContentState]);

  // Table edits reach the store like keystrokes; the effect below then
  // replaces the hidden source view's document.
  const onTableChange = (text: string) => {
    const store = getStore();
    if (docKeyRef.current !== `${store.vaultPath ?? ""}\0${store.activePath ?? ""}`) return;
    store.setContentFromEditor(text);
  };

  const goToHeading = (line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const position = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
    view.focus();
  };

  // The store owns text and unsaved revisions. Sessions retain only reusable
  // editing state; they must never override the current store snapshot.
  type CachedSession = { state: EditorState; scrollTop: number };
  const sessionsRef = useRef(new Map<string, CachedSession>());
  const docKeyRef = useRef("");
  const key = `${vaultPath ?? ""}\0${activePath ?? ""}`;
  const rememberSession = (sessionKey: string, state: EditorState, scrollTop: number) => {
    const sessions = sessionsRef.current;
    sessions.delete(sessionKey);
    sessions.set(sessionKey, { state, scrollTop });
    let chars = [...sessions.values()].reduce((sum, item) => sum + item.state.doc.length, 0);
    while (sessions.size > 8 || chars > 8 * 1024 * 1024) {
      const oldest = sessions.keys().next().value!;
      chars -= sessions.get(oldest)!.state.doc.length;
      sessions.delete(oldest);
    }
  };
  const onUserEditRef = useRef((text: string, activity: EditorActivityChange) => {
    const store = getStore();
    // A view from the preceding React commit cannot edit the newly selected file.
    if (docKeyRef.current !== `${store.vaultPath ?? ""}\0${store.activePath ?? ""}`) return;
    lastEditorTextRef.current = text;
    store.setContentFromEditor(text, activity);
  });

  // Tracks which note the view's document belongs to, so a note SWITCH can be
  // told apart from an external change to the same note. They must be handled
  // differently or undo corrupts files (see the swap effect below).
  const docPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    docPathRef.current = getStore().activePath;
    const initialKey = `${getStore().vaultPath ?? ""}\0${docPathRef.current ?? ""}`;
    docKeyRef.current = initialKey;
    const initial = sessionsRef.current.get(initialKey);
    const view = new EditorView({
      parent: hostRef.current,
      state: initial && docText(initial.state) === getStore().content ? initial.state : makeState(getStore().content, onUserEditRef.current),
    });
    if (initial) view.scrollDOM.scrollTop = initial.scrollTop;
    viewRef.current = view;
    const commands: EditorCommandTarget = {
      path: () => docPathRef.current,
      openFind: () => {
        if (!docPathRef.current) return false;
        openSearchPanel(view);
        return true;
      },
      insertText: (text) => {
        const store = getStore();
        if (!docPathRef.current || !view.state.facet(EditorView.editable) ||
          docKeyRef.current !== `${store.vaultPath ?? ""}\0${store.activePath ?? ""}`) return false;
        view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.paste" });
        view.focus();
        return true;
      },
    };
    const unregister = registerEditorCommands(commands);
    const onFocus = () => focusEditorCommands(commands);
    view.contentDOM.addEventListener("focus", onFocus);
    return () => {
      view.contentDOM.removeEventListener("focus", onFocus);
      unregister();
      if (docPathRef.current) rememberSession(docKeyRef.current, view.state, view.scrollDOM.scrollTop);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Restore history only for exact matching text and vault/document identity.
  // External replacements start fresh history, including same-note updates.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previousPath = docPathRef.current;
    const pathChanged = docKeyRef.current !== key;
    docPathRef.current = activePath;
    // Our own keystroke echoed back — the view already has this text.
    // (Identity check: the store holds the exact string we handed it.)
    if (!pathChanged && content === lastEditorTextRef.current) return;
    const next = content;
    const cur = docText(view.state);
    if (pathChanged) {
      const oldKey = docKeyRef.current;
      docKeyRef.current = key;
      if (previousPath) rememberSession(oldKey, view.state, view.scrollDOM.scrollTop);
      const cached = sessionsRef.current.get(key);
      lastEditorTextRef.current = null;
      if (cached && docText(cached.state) === next) {
        view.setState(cached.state);
        view.scrollDOM.scrollTop = cached.scrollTop;
      } else {
        view.setState(makeState(next, onUserEditRef.current, canEdit(activePath, activeContentState, next)));
      }
    } else if (cur !== next) {
      lastEditorTextRef.current = null;
      const anchor = Math.min(view.state.selection.main.anchor, next.length);
      view.setState(makeState(next, onUserEditRef.current, canEdit(activePath, activeContentState, next)));
      view.dispatch({ selection: { anchor } });
    }
  }, [key, activePath, activeContentState, content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(
      canEdit(activePath, getStore().activeContentState, getStore().content)
    )) });
  }, [key, activePath, activeContentState, tooLarge]);

  // The host div is always rendered so CodeMirror can mount even before the
  // first note is selected (the vault picks the first note a tick after the
  // editor mounts). The empty-state is an overlay, not a replacement.
  return (
    <div className="editor-wrap">
      <div className="editor-toolbar">
        <button
          className="seg-btn"
          onClick={() => getStore().openRevisionHistory()}
          title="Open revision history for this document"
          disabled={!activePath}
        >
          History
        </button>
        <button
          className="seg-btn"
          onClick={() => { const view = viewRef.current; if (view) openSearchPanel(view); }}
          title="Find and replace in this note (Ctrl/Cmd+F)"
          aria-keyshortcuts="Control+F Meta+F"
          disabled={!activePath || activeContentState !== "ready"}
        >
          Find
        </button>
        {prose && <button
          className={"seg-btn" + (outlineOpen ? " on" : "")}
          aria-pressed={outlineOpen}
          onClick={() => setOutlineOpen((open) => !open)}
          disabled={!activePath || activeContentState !== "ready"}
          title="Show document outline"
        >
          Outline
        </button>}
        {delimiter !== null && <div className="seg">
          <button className={"seg-btn" + (showTable ? " on" : "")} aria-pressed={showTable} onClick={() => setTableView(true)}>
            Table
          </button>
          <button className={"seg-btn" + (!showTable ? " on" : "")} aria-pressed={!showTable} onClick={() => setTableView(false)}>
            Raw
          </button>
        </div>}
        {prose && <div className="seg">
          <button
            className={"seg-btn" + (mode === "source" ? " on" : "")}
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
          >
            Source
          </button>
          <button
            className={"seg-btn" + (mode === "live" ? " on" : "")}
            aria-pressed={mode === "live"}
            onClick={() => setMode("live")}
          >
            Live
          </button>
        </div>}
      </div>
      {activePath && activeContentState === "invalid-encoding" && <p role="status">This file is not valid UTF-8; opened read-only to avoid corrupting it.</p>}
      {activePath && activeContentState === "ready" && tooLarge && !showTable && <p role="status">
        This file is larger than {formatBytes(MAX_EDITABLE_TEXT_CHARS)} of text; opened read-only so typing stays fast.
      </p>}
      <div className={"editor-workspace " + (showTable ? "table" : prose ? mode : "source") + (prose && outlineOpen ? " with-outline" : "")}>
        <div className="editor-host" ref={hostRef} />
        {showTable && delimiter !== null && activePath && (activeContentState === "ready" || activeContentState === "invalid-encoding") && (
          <TableEditor
            key={key}
            text={content}
            delimiter={delimiter}
            readOnlyReason={activeContentState !== "ready" ? "this file is not valid UTF-8, so saving could corrupt it."
              : content.length > MAX_TABLE_EDIT_CHARS ? `tables above ${formatBytes(MAX_TABLE_EDIT_CHARS)} are view-only to keep edits fast; use Raw to edit.`
              : null}
            onChange={onTableChange}
          />
        )}
        {activePath && activeContentState !== "ready" && activeContentState !== "invalid-encoding" && (
          <div className="editor-load-state" role="status">
            <p>{activeContentState === "loading" ? "Loading document…" :
              activeContentState === "size-limit" ? "This file exceeds the 8 MiB automatic text limit." :
              "This document could not be read. Its content is unavailable."}</p>
            {activeContentState !== "loading" && <button className="btn" onClick={() => void loadActiveContent()}>
              {activeContentState === "size-limit" ? "Load file anyway" : "Retry read"}
            </button>}
          </div>
        )}
        {prose && mode === "live" && (
          <aside className="editor-live-preview">
            <MarkdownView source={content} />
          </aside>
        )}
        {prose && outlineOpen && (
          <nav className="editor-outline" aria-label="Document outline">
            {headings.map((heading) => (
              <button
                key={`${heading.line}-${heading.label}`}
                className="editor-outline-item"
                style={{ paddingInlineStart: `${8 + (heading.level - 1) * 12}px` }}
                onClick={() => goToHeading(heading.line)}
              >
                {heading.label}
              </button>
            ))}
          </nav>
        )}
      </div>
      {!activePath && (
        <div className="editor-empty">
          Select a note on the left, or create a new one.
        </div>
      )}
    </div>
  );
}
