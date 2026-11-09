import {
  bumpActivityAmount,
  changedLineStats,
  changedSnippet
} from "../lib/activity";
import { applyTemplate, editCalendarJson, localISO, localTime, serializeEvents } from "../lib/daily";
import { forkContentCache } from "../lib/documentWorkingSet";
import { extractAliases, extractLinks, extractTags } from "../lib/markdownExtract";
import { isMarkdownPath } from "../lib/markdownCode";
import { taskLineHasText, updateTaskLine } from "../lib/tasks";
import { createNote } from "../lib/vault";
import type { VaultFile } from "../types";

import type { StoreApi } from "zustand";
import type { AppState } from "../storeTypes";
type Port = { get: () => AppState; set: StoreApi<AppState>["setState"] };

const CALENDAR_FILE = "calendar.json";

interface Dependencies extends Port {
  getGeneration: () => number;
  reportingFailure: (label: string, run: () => Promise<void>) => Promise<void>;
  saveTextMutation: (file: VaultFile, content: string, expectedContent: string) => Promise<void>;
  addNote: (file: VaultFile, content: string) => void;
}

/** Daily notes, templates, calendar events and task lines. Each edit goes
 *  through the verified text-save queue against the loaded baseline. */
export function createCalendarController({ get, set, getGeneration, reportingFailure, saveTextMutation, addNote }: Dependencies) {
  const actions: Pick<AppState,
    "openDailyNote" | "renderTemplate" | "addCalendarEvent" | "removeCalendarEvent" | "addPersonalTask" | "updateTask"> = {
    openDailyNote: async (dateISO) => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      const folder = get().settings.dailyFolder.trim().replace(/^\/+|\/+$/g, "");
      const rel = folder ? `${folder}/${dateISO}.md` : `${dateISO}.md`;
      if (get().fileFor(rel)) {
        await get().selectFile(rel);
        return;
      }
      let body = `# ${dateISO}\n\n`;
      const tf = get().settings.templatesFolder.trim().replace(/^\/+|\/+$/g, "");
      const tplRel = tf ? `${tf}/daily.md` : "daily.md";
      let file: VaultFile | undefined;
      await reportingFailure("Open daily note", async () => {
        if (get().fileFor(tplRel)) {
          const tpl = await get().ensureContent(tplRel);
          if (!current()) return;
          body = applyTemplate(tpl, {
            date: dateISO,
            time: localTime(),
            title: dateISO,
          });
        }
        file = await createNote(root, rel, body);
      });
      if (!file || !current()) return;
      addNote(file, body);
      await get().selectFile(rel);
    },

    renderTemplate: async (templateRel) => {
      const root = get().vaultPath;
      if (!root || !get().fileFor(templateRel)) return null;
      const generation = getGeneration();
      const template = await get().ensureContent(templateRel);
      if (get().vaultPath !== root || getGeneration() !== generation) return null;
      const active = get().activePath;
      const title = active ? get().notes[active]?.title ?? (active.split("/").pop() ?? active).replace(/\.[^.]+$/, "") : "";
      return applyTemplate(template, { date: localISO(), time: localTime(), title });
    },

    // Calendar events persist in calendar.json at the vault root.
    addCalendarEvent: async (date, title) => {
      const root = get().vaultPath;
      const t = title.trim();
      if (!root || !date || !t) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("Add calendar event", async () => {
        const found = get().fileFor(CALENDAR_FILE);
        if (found) {
          const loaded = await get().ensureContent(CALENDAR_FILE);
          if (!current()) return;
          const file = get().fileFor(CALENDAR_FILE);
          if (!file) throw new Error(`${CALENDAR_FILE} is no longer available.`);
          const prev = get().contentCache[CALENDAR_FILE] ?? loaded;
          const edited = editCalendarJson(prev, { add: { date, title: t } });
          if (!edited) throw new Error(`${CALENDAR_FILE} is not a valid event list; fix it before adding events.`);
          const { events, content } = edited;
          set({
            calendarEvents: events,
            content:
              get().activePath === CALENDAR_FILE ? content : get().content,
            contentCache: forkContentCache(get().contentCache, { [CALENDAR_FILE]: content }),
          });
          await saveTextMutation(file, content, prev);
          return;
        }

        const events = [...get().calendarEvents, { date, title: t }];
        const content = serializeEvents(events);
        const file = await createNote(root, CALENDAR_FILE, content);
        if (!current()) return;
        set({
          files: [...get().files, file].sort((a, b) =>
            a.relPath.localeCompare(b.relPath)
          ),
          calendarEvents: events,
          content:
            get().activePath === CALENDAR_FILE ? content : get().content,
          contentCache: forkContentCache(get().contentCache, { [CALENDAR_FILE]: content }),
        });
      });
    },
    removeCalendarEvent: async (date, title) => {
      const root = get().vaultPath;
      if (!root) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("Remove calendar event", async () => {
        const found = get().fileFor(CALENDAR_FILE);
        if (!found) return;
        const loaded = await get().ensureContent(CALENDAR_FILE);
        if (!current()) return;
        const file = get().fileFor(CALENDAR_FILE);
        if (!file) throw new Error(`${CALENDAR_FILE} is no longer available.`);
        const prev = get().contentCache[CALENDAR_FILE] ?? loaded;
        const edited = editCalendarJson(prev, { remove: { date, title } });
        if (!edited) throw new Error(`${CALENDAR_FILE} is not a valid event list; fix it before removing events.`);
        const { events, content } = edited;
        set({
          calendarEvents: events,
          content:
            get().activePath === CALENDAR_FILE ? content : get().content,
          contentCache: forkContentCache(get().contentCache, { [CALENDAR_FILE]: content }),
        });
        await saveTextMutation(file, content, prev);
      });
    },

    // Personal tasks the user adds with the + button live in one note (default
    // Tasks.md). Everything else parsed from the vault counts as agent work.
    addPersonalTask: async (text) => {
      const root = get().vaultPath;
      const body = text.trim();
      if (!root || !body) return false;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      const rel = (get().settings.tasksFile || "Tasks.md").trim();
      const line = `- [ ] ${body}`;
      let added = false;
      await reportingFailure("Add task", async () => {
        if (!get().fileFor(rel)) {
          const content = `# Tasks\n\n${line}\n`;
          const file = await createNote(root, rel, content);
          if (!current()) return;
          addNote(file, content);
          added = true;
          return;
        }
        const loaded = await get().ensureContent(rel);
        if (!current()) return;
        const existing = get().fileFor(rel);
        if (!existing) {
          set({ status: `Add task failed: ${rel} is no longer available.` });
          return;
        }
        const cur = get().contentCache[rel] ?? loaded;
        const next = cur.replace(/\s*$/, "") + "\n" + line + "\n";
        const notes = { ...get().notes };
        const m = notes[rel];
        if (m) {
          notes[rel] = {
            ...m,
            rawLinks: extractLinks(next, isMarkdownPath(rel)),
            tags: extractTags(next, isMarkdownPath(rel)),
            aliases: extractAliases(next),
          };
        }
        set({
          notes,
          content: get().activePath === rel ? next : get().content,
          contentCache: forkContentCache(get().contentCache, { [rel]: next }),
        });
        // From here the task is in the editor cache; a failed write stays a
        // dirty save issue with Retry rather than losing the text.
        added = true;
        await saveTextMutation(existing, next, cur);
      });
      return added;
    },

    updateTask: async (relPath, line, patch, expectedText) => {
      const root = get().vaultPath;
      if (!root || !get().fileFor(relPath)) return;
      const generation = getGeneration();
      const current = () => get().vaultPath === root && getGeneration() === generation;
      await reportingFailure("Update task", async () => {
        const loaded = await get().ensureContent(relPath);
        if (!current()) return;
        const file = get().fileFor(relPath);
        if (!file) {
          set({ status: `Update task failed: ${relPath} is no longer available.` });
          return;
        }
        const prev = get().contentCache[relPath] ?? loaded;
        if (expectedText !== undefined && !taskLineHasText(prev, line, expectedText)) {
          set({ status: `Task in ${relPath} changed since the list was shown; nothing was updated.` });
          return;
        }
        const next = updateTaskLine(prev, line, patch, expectedText);
        if (next === prev) return;
        set({
          content: get().activePath === relPath ? next : get().content,
          contentCache: forkContentCache(get().contentCache, { [relPath]: next }),
          status: `Updated task in ${relPath}`,
        });
        bumpActivityAmount(
          relPath,
          0.6,
          "edit",
          "Task moved on Kanban board",
          changedSnippet(prev, next),
          changedLineStats(prev, next)
        );
        await saveTextMutation(file, next, prev);
      });
    },
  };
  return { actions };
}
