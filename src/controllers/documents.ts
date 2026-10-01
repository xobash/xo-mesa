import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet
} from "../lib/activity";
import { forkContentCache, markCacheTaskStable } from "../lib/documentWorkingSet";
import { buildNotes, resolveTarget } from "../lib/graph";
import { extractAliases, extractLinks, extractTags } from "../lib/markdownExtract";
import {
  openViewInWorkspace,
  placeInCenter
} from "../lib/panes";
import { MAX_TEXT_CACHE_FILE_BYTES } from "../lib/textCachePlan";
import {
  IN_TAURI,
  createNote,
  isTextualVaultFile,
  peekNote,
  readNoteResult,
  resolveTextVaultLink
} from "../lib/vault";
import type {
  Settings,
  VaultFile
} from "../types";

import { stat } from "@tauri-apps/plugin-fs";
import { markMesaPerf } from "../lib/mesaPerf";
import {
  retainLazyTextCache,
} from "../lib/textCachePlan";
import {
  TextSaveCoordinator
} from "../lib/textSaveCoordinator";

import type { StoreApi } from "zustand";
import type { AppState } from "../store";
type Port = { get: () => AppState; set: StoreApi<AppState>["setState"] };

interface Dependencies extends Port {
  getGeneration: () => number; textSaves: TextSaveCoordinator<VaultFile>; commitSettings: (settings: Settings) => void; reportingFailure: (label: string, run: () => Promise<void>) => Promise<void>;
}
export function createDocumentController({ get, set, getGeneration, textSaves, commitSettings, reportingFailure }: Dependencies) {
  const pendingContentReads = new Map<string, Promise<string>>();
  // Lazy non-markdown content is evictable. Keep the recency metadata beside
  // the store, not in React state, and clear it on every vault generation so
  // an old vault cannot pin keys in the new one.
  const lazyContentRecency = new Map<string, number>();
  let lazyContentClock = 0;
  const touchLazyContent = (relPath: string): void => {
    lazyContentRecency.set(relPath, ++lazyContentClock);
  };
  // Hover-preview peeks: short-lived, capped, and separate from contentCache
  // (a truncated peek must never be mistaken for the file's real content).
  const peekCache = new Map<string, { text: string; at: number }>();
  const pendingPeekReads = new Map<string, Promise<string>>();
  const readKey = (root: string | null, generation: number, relPath: string) =>
    `${generation}\0${root ?? ""}\0${relPath}`;
  const PEEK_TTL_MS = 10_000;
  const PEEK_CACHE_MAX = 32;
  function addNote(file: VaultFile, content: string) {
    bumpActivityAmount(file.relPath, 1.3, "create");
    const notes = {
      ...get().notes,
      [file.relPath]: {
        relPath: file.relPath,
        title: file.name,
        rawLinks: extractLinks(content),
        tags: extractTags(content),
        aliases: extractAliases(content),
        firstImagePath: undefined,
      },
    };
    set({
      files: [...get().files, file].sort((a, b) =>
        a.relPath.localeCompare(b.relPath)
      ),
      notes,
      contentCache: forkContentCache(get().contentCache, { [file.relPath]: content }),
      status: `${Object.keys(notes).length} notes`,
    });
  }

  const actions: Pick<AppState, 'selectFile' | 'loadActiveContent' | 'openFile' | 'openTarget' | 'setContentFromEditor' | 'ensureContent' | 'ensurePeek' | 'closeTab'> = {
    selectFile: async (relPath) => {
      const file = get().fileFor(relPath);
      if (!file) return;
      const settings = get().settings;
      if (settings.centerView === "empty") {
        commitSettings({
          ...settings,
          ...openViewInWorkspace(settings.centerView, settings.rightStack, "doc"),
        });
      }
      // text/markdown loads content for the editor; media (image/pdf/video)
      // renders from its path, so no content read is needed.
      const textual = isTextualVaultFile(file);
      const tabs = get().settings.enableTabs
        ? get().openTabs.includes(relPath)
          ? get().openTabs
          : [...get().openTabs, relPath]
        : [];
      // Open instantly: switch the active file now, stream the content in as
      // soon as the disk read lands. On a cache hit this is fully synchronous.
      const cached = textual ? get().contentCache[relPath] : "";
      const openRoot = get().vaultPath;
      const openGeneration = getGeneration();
      markMesaPerf("file-open-requested", {
        textual,
        cached: cached !== undefined,
      });
      set({
        activePath: relPath, content: cached ?? "", openTabs: tabs,
        activeContentState: textual && cached === undefined ? "loading" : "ready"
      });
      if (!textual || cached !== undefined) {
        markMesaPerf("file-open-ready", { textual, cached: cached !== undefined });
      }
      if (textual && cached === undefined) {
        let text: string;
        try {
          // The catalog size can be stale if another app changed the file.
          // Check the live size before an automatic read on desktop.
          const size = IN_TAURI ? (await stat(file.path)).size : file.size;
          if (size !== undefined && size > MAX_TEXT_CACHE_FILE_BYTES) {
            if (get().activePath === relPath && get().vaultPath === openRoot && getGeneration() === openGeneration)
              set({ activeContentState: "size-limit" });
            return;
          }
          text = await get().ensureContent(relPath);
        } catch (error) {
          if (get().activePath === relPath && get().vaultPath === openRoot && getGeneration() === openGeneration)
            set({ activeContentState: "failed", status: `Could not read ${relPath}: ${String(error)}` });
          return;
        }
        // Commit only if this file is still the active one, and prefer the
        // cache (it may contain edits made while the read was in flight).
        if (
          get().activePath === relPath &&
          get().vaultPath === openRoot &&
          getGeneration() === openGeneration
        ) {
          set({ content: get().contentCache[relPath] ?? text, activeContentState: "ready" });
          markMesaPerf("file-open-ready", { textual: true, cached: false });
        }
      }
    },

    loadActiveContent: async () => {
      const relPath = get().activePath;
      if (!relPath) return;
      const root = get().vaultPath;
      const generation = getGeneration();
      set({ activeContentState: "loading" });
      try {
        const text = await get().ensureContent(relPath);
        if (get().vaultPath === root && getGeneration() === generation && get().activePath === relPath)
          set({ content: get().contentCache[relPath] ?? text, activeContentState: "ready" });
      } catch (error) {
        if (get().vaultPath === root && getGeneration() === generation && get().activePath === relPath)
          set({ activeContentState: "failed", status: `Could not read ${relPath}: ${String(error)}` });
      }
    },

    // Open any file in the MAIN pane (text in the editor, media in a viewer).
    // The separate pop-out window is reserved for graph clicks / tab drag-out /
    // the "Open in new window" context action.
    openFile: async (relPath) => {
      const settings = get().settings;
      if (settings.centerView === "empty") {
        commitSettings({
          ...settings,
          ...openViewInWorkspace(settings.centerView, settings.rightStack, "doc"),
        });
      } else if (settings.centerView !== "doc") {
        commitSettings({
          ...settings,
          ...placeInCenter(settings.centerView, settings.rightStack, "doc"),
        });
      }
      await get().selectFile(relPath);
    },

    openTarget: async (target) => {
      const linkedFile = resolveTextVaultLink(get().files, target);
      if (linkedFile) {
        await get().selectFile(linkedFile.relPath);
        return;
      }
      const id = resolveTarget(get().notes, target);
      if (id) {
        await get().selectFile(id);
        return;
      }
      const root = get().vaultPath;
      if (!root) return;
      const rel = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
      const content = `# ${target}\n\n`;
      let file: VaultFile | undefined;
      await reportingFailure("Create linked note", async () => {
        file = await createNote(root, rel, content);
      });
      if (!file) return;
      addNote(file, content);
      await get().selectFile(file.relPath);
    },

    setContentFromEditor: (text, activity) => {
      const active = get().activePath;
      if (!active || get().activeContentState !== "ready" || get().contentCache[active] === undefined) return;
      const prev = get().contentCache[active] ?? get().content;
      const file = get().fileFor(active);
      const contentCache = forkContentCache(get().contentCache, { [active]: text });
      if (activity?.tasksUnchanged) markCacheTaskStable(contentCache, active);
      set({
        content: text,
        contentCache,
      });
      // tag the edit with the chunk that changed, so the live card highlights it.
      // One keystroke = one short, subtle blip (see activity.ts decay).
      bumpActivityAmount(
        active,
        0.5,
        "edit",
        undefined,
        activity?.snippet ?? changedSnippet(prev, text),
        activity?.lines ?? changedLineStats(prev, text)
      );
      if (file) textSaves.markDirty(file.path, file, text, prev);
    },

    // Flush every dirty path. Clean blur/hide/close events perform no writes.
    ensureContent: async (relPath) => {
      const root = get().vaultPath;
      const generation = getGeneration();
      const key = readKey(root, generation, relPath);
      const file = get().fileFor(relPath);
      if (!file) return "";
      const cached = get().contentCache[relPath];
      if (cached !== undefined) {
        if (!file.isMarkdown) touchLazyContent(relPath);
        return cached;
      }
      const pending = pendingContentReads.get(key);
      if (pending) return pending;
      // Never pull a non-text file through the text pipeline. `readNote`
      // decodes bytes as UTF-8, so caching a PDF/image here would put a lossy
      // decode of it into `contentCache` — content every text consumer,
      // including the crash-safety flush, would then treat as that file's real
      // text. Callers of this are the text surfaces (editor, code/html/rtf
      // views); the activity bridge also calls it for whatever path an agent
      // touched, which is exactly how a binary could get in.
      if (!isTextualVaultFile(file)) return "";
      const read = readNoteResult(file)
        .then((result) => {
          if (!result.ok) throw new Error(`File read failed: ${relPath}`);
          const text = result.text;
          if (getGeneration() !== generation || get().vaultPath !== root) return "";
          // If newer content landed in the cache while the disk read was in
          // flight (the user typed, an agent wrote), the cache wins — never
          // clobber live edits with stale disk bytes.
          const existing = get().contentCache[relPath];
          if (existing !== undefined) return existing;
          const current = get().fileFor(relPath);
          if (
            getGeneration() === generation &&
            get().vaultPath === root &&
            current?.path === file.path
          ) {
            touchLazyContent(relPath);
            const state = get();
            const pinned = new Set<string>();
            for (const candidate of state.files) {
              if (
                candidate.relPath === state.activePath ||
                textSaves.isDirty(candidate.path)
              ) {
                pinned.add(candidate.relPath);
              }
            }
            const cache = forkContentCache(state.contentCache, { [relPath]: text });
            const bounded = retainLazyTextCache(
              cache,
              state.files,
              isTextualVaultFile,
              lazyContentRecency,
              pinned
            );
            const note = state.notes[relPath] ?? buildNotes(state.files, new Map([[relPath, text]]), new Set([relPath]))[relPath];
            const reason = state.unreadableTextReasons[relPath];
            const unreadableTextReasons = reason ? { ...state.unreadableTextReasons } : state.unreadableTextReasons;
            if (reason) delete unreadableTextReasons[relPath];
            set({
              ...(bounded === state.contentCache ? {} : { contentCache: bounded }),
              ...(note && !state.notes[relPath] ? { notes: { ...state.notes, [relPath]: note } } : {}),
              ...(reason ? {
                unreadableTextReasons,
                unindexedTextFiles: Math.max(0, state.unindexedTextFiles - 1),
                skippedTextFiles: Math.max(0, state.skippedTextFiles - (reason === "skipped" ? 1 : 0)),
                failedTextFiles: Math.max(0, state.failedTextFiles - (reason === "failed" ? 1 : 0)),
              } : {}),
            });
          }
          return getGeneration() === generation && get().vaultPath === root
            ? text
            : "";
        })
        .finally(() => {
          if (pendingContentReads.get(key) === read) pendingContentReads.delete(key);
        });
      pendingContentReads.set(key, read);
      return read;
    },

    ensurePeek: async (relPath) => {
      const full = get().contentCache[relPath];
      if (full !== undefined) return full;
      const root = get().vaultPath;
      const generation = getGeneration();
      const key = readKey(root, generation, relPath);
      const now = Date.now();
      const hit = peekCache.get(key);
      if (hit && now - hit.at < PEEK_TTL_MS) return hit.text;
      const pending = pendingPeekReads.get(key);
      if (pending) return pending;
      const file = get().fileFor(relPath);
      if (!file) return "";
      const read = peekNote(file)
        .then((text) => {
          if (getGeneration() !== generation || get().vaultPath !== root) return "";
          peekCache.set(key, { text, at: Date.now() });
          // Tiny LRU-ish cap: drop the oldest insertion once past the cap.
          if (peekCache.size > PEEK_CACHE_MAX) {
            const oldest = peekCache.keys().next().value;
            if (oldest !== undefined) peekCache.delete(oldest);
          }
          return text;
        })
        .finally(() => {
          if (pendingPeekReads.get(key) === read) pendingPeekReads.delete(key);
        });
      pendingPeekReads.set(key, read);
      return read;
    },

    closeTab: (relPath) => {
      const closingFile = get().fileFor(relPath);
      // The dirty record is independent of tab state. Start its drain now; a
      // later window close or vault switch will await the same promise.
      if (closingFile) {
        void textSaves.flush(closingFile.path).catch(() => undefined);
      }
      const tabs = get().openTabs.filter((t) => t !== relPath);
      let active = get().activePath;
      let content = get().content;
      if (active === relPath) {
        active = tabs[tabs.length - 1] ?? null;
        content = active ? get().contentCache[active] ?? "" : "";
      }
      set({ openTabs: tabs, activePath: active, content });
      if (active && get().contentCache[active] === undefined) {
        void get().selectFile(active);
      }
    },

  };
  return { actions, addNote, reset() { pendingContentReads.clear(); pendingPeekReads.clear(); peekCache.clear(); lazyContentRecency.clear(); lazyContentClock = 0; } };
}
