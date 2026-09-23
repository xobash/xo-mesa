// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { useAppStore } from "../store";
import type { VaultFile } from "../types";
import { DEMO_ROOT, readNote, writeNote } from "../lib/vault";
import statusBarSource from "./StatusBar.tsx?raw";

/**
 * The status bar derives its word/char pair from a DEFERRED copy of the live
 * editor text (see StatusBar.tsx): the O(note) `countWords` scan measured
 * 6.2 ms per keystroke on a real 420 kB note when it ran inside the
 * keystroke's own commit. These tests pin the two things that must stay true:
 * the settled numbers equal the live text's numbers, and the words/chars pair
 * is derived from ONE string so the two can never disagree mid-transition.
 */

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const text = (sel: string) =>
  Array.from(host.querySelectorAll("footer.statusbar span"))
    .map((s) => s.textContent ?? "")
    .find((t) => t.endsWith(sel));

describe("StatusBar deferred text stats", () => {
  it("settles on the live text's word and char counts", async () => {
    act(() => {
      useAppStore.setState({
        activePath: "n.md",
        content: "alpha beta gamma",
      });
    });
    act(() => {
      root.render(<StatusBar />);
    });
    expect(text(" words")).toBe("3 words");
    expect(text(" chars")).toBe("16 chars");

    // A burst of edits: after React settles, the numbers match the final text.
    act(() => {
      useAppStore.setState({ content: "alpha beta gamma delta" });
      useAppStore.setState({ content: "alpha beta gamma delta epsilon" });
    });
    // Flush the deferred transition.
    await act(async () => {});
    expect(text(" words")).toBe("5 words");
    expect(text(" chars")).toBe("30 chars");
  });

  it("renders the store's status feed, with failures as alerts", () => {
    act(() => {
      useAppStore.setState({ activePath: "n.md", content: "x", status: "Importing…" });
    });
    act(() => {
      root.render(<StatusBar />);
    });
    const info = host.querySelector(".sb-status");
    expect(info?.textContent).toBe("Importing…");
    expect(info?.getAttribute("role")).toBe("status");

    // A failure — the case that used to be written and rendered by NOTHING,
    // so a failed save was silent — must be visible and announced.
    act(() => {
      useAppStore.setState({ status: "Save failed: disk full" });
    });
    const err = host.querySelector(".sb-status");
    expect(err?.textContent).toBe("Save failed: disk full");
    expect(err?.classList.contains("err")).toBe(true);
    expect(err?.getAttribute("role")).toBe("alert");

    // The post-open "N notes" summary duplicates the count already shown in
    // this same bar and is suppressed.
    act(() => {
      useAppStore.setState({ notes: {}, status: "0 notes" });
    });
    expect(host.querySelector(".sb-status")).toBeNull();
  });

  it("derives words and chars from the same (deferred) string", () => {
    // Source contract: both numbers must come from the ONE deferred text, not
    // one from the live `content` — a split pair could show a word count from
    // one document and a char count from another during a transition, and
    // computing either from the live text puts the O(note) scan back inside
    // the keystroke's commit.
    expect(statusBarSource).toMatch(/useDeferredValue\(content\)/);
    expect(statusBarSource).toMatch(/countWords\(statsText\)/);
    expect(statusBarSource).toMatch(/statsText\.length/);
    expect(statusBarSource).not.toMatch(/countWords\(content\)/);
    expect(statusBarSource).not.toMatch(/content\.length/);
  });
});

function demoFile(relPath: string): VaultFile {
  return {
    path: `${DEMO_ROOT}/${relPath}`,
    relPath,
    name: relPath.replace(/\.md$/, ""),
    ext: "md",
    isMarkdown: true,
  };
}

async function seedDirtySaveIssue(relPath: string) {
  const file = demoFile(relPath);
  await writeNote(file, "disk copy #disk");
  act(() => {
    useAppStore.setState({
      vaultPath: DEMO_ROOT,
      files: [file],
      notes: {
        [relPath]: {
          relPath,
          title: file.name,
          rawLinks: [],
          tags: ["stale"],
          aliases: [],
        },
      },
      contentCache: { [relPath]: "disk copy #disk" },
      activePath: relPath,
      openTabs: [relPath],
      content: "disk copy #disk",
    });
    useAppStore.getState().setContentFromEditor("local unsaved copy #local");
    useAppStore.setState({
      textSaveIssues: {
        [file.path]: {
          key: file.path,
          relPath,
          message: "disk changed",
          busy: null,
        },
      },
    });
  });
  return file;
}

describe("StatusBar save recovery", () => {
  it("lists every failed dirty path and exposes compact actions", () => {
    const retry = vi.fn(async () => undefined);
    const useDisk = vi.fn(async () => undefined);
    act(() => {
      useAppStore.setState({
        textSaveIssues: {
          first: {
            key: "first",
            relPath: "First.md",
            message: "disk full",
            busy: null,
          },
          second: {
            key: "second",
            relPath: "Second.md",
            message: "disk changed",
            busy: null,
          },
        },
        retryTextSaveIssue: retry,
        useDiskTextForSaveIssue: useDisk,
      });
      root.render(<StatusBar />);
    });

    expect(host.querySelector(".sb-save-issues summary")?.textContent).toContain(
      "2 unsaved"
    );
    expect(host.querySelectorAll(".sb-save-issue")).toHaveLength(2);

    const retryButton = host.querySelector(
      'button[aria-label="Retry saving First.md"]'
    ) as HTMLButtonElement;
    const diskButton = host.querySelector(
      'button[aria-label="Use disk copy of Second.md"]'
    ) as HTMLButtonElement;
    act(() => {
      retryButton.click();
      diskButton.click();
    });
    expect(retry).toHaveBeenCalledWith("first");
    expect(useDisk).toHaveBeenCalledWith("second");
  });

  it("retries the failed path and clears only its issue after success", async () => {
    vi.useFakeTimers();
    const file = await seedDirtySaveIssue("__status-retry.md");
    act(() => {
      useAppStore.setState({
        textSaveIssues: {
          ...useAppStore.getState().textSaveIssues,
          other: {
            key: "other",
            relPath: "Other.md",
            message: "still blocked",
            busy: null,
          },
        },
      });
    });

    await act(async () => {
      await useAppStore.getState().retryTextSaveIssue(file.path);
    });

    expect(await readNote(file)).toBe("local unsaved copy #local");
    expect(useAppStore.getState().textSaveIssues[file.path]).toBeUndefined();
    expect(useAppStore.getState().textSaveIssues.other?.relPath).toBe("Other.md");
  });

  it("keeps local text on cancel, then reloads disk text after confirmation", async () => {
    vi.useFakeTimers();
    const file = await seedDirtySaveIssue("__status-use-disk.md");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => {
      await useAppStore.getState().useDiskTextForSaveIssue(file.path);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().content).toBe("local unsaved copy #local");
    expect(useAppStore.getState().textSaveIssues[file.path]).toBeDefined();

    // A second hold can start only if cancel released the first one safely.
    confirm.mockReturnValue(true);
    await act(async () => {
      await useAppStore.getState().useDiskTextForSaveIssue(file.path);
    });
    expect(useAppStore.getState().content).toBe("disk copy #disk");
    expect(useAppStore.getState().contentCache[file.relPath]).toBe(
      "disk copy #disk"
    );
    expect(useAppStore.getState().notes[file.relPath]?.tags).toEqual(["disk"]);
    expect(useAppStore.getState().textSaveIssues[file.path]).toBeUndefined();
  });
});

describe('persistent save and settings feedback', () => {
  it('shows pending, saving, failed and clean text states independently of transient messages', () => {
    act(() => { useAppStore.setState({ activePath: 'Note.md', textSaveState: { pending: 1, saving: 0, failed: 0 } }); root.render(<StatusBar />); });
    expect(host.querySelector('.sb-save-state')?.textContent).toBe('Unsaved text changes');
    act(() => useAppStore.setState({ textSaveState: { pending: 1, saving: 1, failed: 0 }, status: 'Imported file' }));
    expect(host.querySelector('.sb-save-state')?.textContent).toBe('Saving text changes…');
    act(() => useAppStore.setState({ textSaveState: { pending: 1, saving: 0, failed: 1 } }));
    expect(host.querySelector('.sb-save-state')?.textContent).toContain('attention');
    act(() => useAppStore.setState({ textSaveState: { pending: 0, saving: 0, failed: 0 } }));
    expect(host.querySelector('.sb-save-state')?.textContent).toBe('Text changes saved');
  });
  it('keeps failed settings visible and exposes retry', () => {
    const retrySettings = vi.fn();
    act(() => { useAppStore.setState({ settingsIssue: 'Settings could not be saved', retrySettings }); root.render(<StatusBar />); });
    expect(host.textContent).toContain('Settings need attention');
    const button = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Retry settings')!;
    act(() => button.click()); expect(retrySettings).toHaveBeenCalledOnce();
  });
});
