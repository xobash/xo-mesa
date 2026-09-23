import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TextSaveCoordinator,
  type TextSaveSnapshot,
} from "./textSaveCoordinator";

afterEach(() => {
  vi.useRealTimers();
});

function coordinator(
  write: (snapshot: TextSaveSnapshot<string>) => Promise<void>,
  onError?: (snapshot: TextSaveSnapshot<string>, error: unknown) => void
) {
  return new TextSaveCoordinator<string>({ delayMs: 500, write, onError });
}

describe("TextSaveCoordinator", () => {
  it("keeps independent debounce state for rapid edits in two files", async () => {
    vi.useFakeTimers();
    const writes: TextSaveSnapshot<string>[] = [];
    const saves = coordinator(async (snapshot) => {
      writes.push(snapshot);
    });

    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    saves.markDirty("/vault/b.md", "b.md", "B1", "B0");
    await vi.advanceTimersByTimeAsync(500);
    await saves.flushAll();

    expect(writes.map(({ key, content }) => [key, content])).toEqual([
      ["/vault/a.md", "A1"],
      ["/vault/b.md", "B1"],
    ]);
    expect(saves.pendingCount()).toBe(0);
  });

  it("does no work when a clean window is flushed", async () => {
    const write = vi.fn(async () => undefined);
    const saves = coordinator(write);

    await saves.flushAll();
    saves.markDirty("/vault/a.md", "a.md", "same", "same");
    await saves.flushAll();

    expect(write).not.toHaveBeenCalled();
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("serializes an edit that arrives during a write and advances its baseline", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: TextSaveSnapshot<string>[] = [];
    let activeWrites = 0;
    let peakWrites = 0;
    const saves = coordinator(async (snapshot) => {
      activeWrites += 1;
      peakWrites = Math.max(peakWrites, activeWrites);
      writes.push(snapshot);
      if (writes.length === 1) await firstBlocked;
      activeWrites -= 1;
    });

    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    const flush = saves.flush("/vault/a.md");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    saves.markDirty("/vault/a.md", "a.md", "A2", "A1");
    releaseFirst();
    await flush;

    expect(peakWrites).toBe(1);
    expect(writes.map(({ content, expectedContent }) => [content, expectedContent])).toEqual([
      ["A1", "A0"],
      ["A2", "A1"],
    ]);
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("retains a failed edit and retries it with the original baseline", async () => {
    const errors: unknown[] = [];
    const writes: TextSaveSnapshot<string>[] = [];
    let fail = true;
    const saves = coordinator(
      async (snapshot) => {
        writes.push(snapshot);
        if (fail) throw new Error("disk busy");
      },
      (_snapshot, error) => errors.push(error)
    );

    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    await expect(saves.flush("/vault/a.md")).rejects.toThrow("disk busy");
    expect(saves.isDirty("/vault/a.md")).toBe(true);
    expect(errors).toHaveLength(1);

    fail = false;
    await saves.flush("/vault/a.md");
    expect(writes.map(({ expectedContent }) => expectedContent)).toEqual([
      "A0",
      "A0",
    ]);
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("does not trust the old baseline after a failed write", async () => {
    const writes: TextSaveSnapshot<string>[] = [];
    let fail = true;
    const saves = coordinator(async (snapshot) => {
      writes.push(snapshot);
      if (fail) throw new Error("external conflict");
    });

    saves.markDirty("/vault/a.md", "a.md", "local edit", "disk baseline");
    await expect(saves.flush("/vault/a.md")).rejects.toThrow("external conflict");

    // Returning to the remembered baseline does not prove what is on disk:
    // the failed write may have reported an external rewrite or deletion.
    saves.markDirty("/vault/a.md", "a.md", "disk baseline", "local edit");
    expect(saves.isDirty("/vault/a.md")).toBe(true);

    fail = false;
    await saves.flush("/vault/a.md");
    expect(writes[writes.length - 1]).toMatchObject({
      content: "disk baseline",
      expectedContent: "disk baseline",
    });
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("cancels a pending write when an edit returns to its disk baseline", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const saves = coordinator(write);

    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    saves.markDirty("/vault/a.md", "a.md", "A0", "A1");
    await vi.advanceTimersByTimeAsync(500);

    expect(write).not.toHaveBeenCalled();
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("waits for an in-flight write before an explicit discard completes", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const saves = coordinator(async () => {
      await blocked;
      finished = true;
    });

    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    void saves.flush("/vault/a.md");
    const discarded = saves.discard(["/vault/a.md"]);
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await discarded;

    expect(finished).toBe(true);
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("cancels a not-yet-started write on explicit discard", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const saves = coordinator(write);

    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    await saves.discard(["/vault/a.md"]);
    await vi.advanceTimersByTimeAsync(500);

    expect(write).not.toHaveBeenCalled();
    expect(saves.isDirty("/vault/a.md")).toBe(false);
  });

  it("does not discard any held path when a later in-flight save fails", async () => {
    let rejectWrite!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const saves = coordinator(async (snapshot) => {
      if (snapshot.key.endsWith("b.md")) await blocked;
    });
    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    saves.markDirty("/vault/b.md", "b.md", "B1", "B0");
    void saves.flush("/vault/b.md").catch(() => undefined);
    await vi.waitFor(() => expect(saves.isDirty("/vault/b.md")).toBe(true));

    const held = saves.hold(["/vault/a.md", "/vault/b.md"], false);
    rejectWrite(new Error("disk busy"));
    await expect(held).rejects.toThrow("disk busy");

    expect(saves.isDirty("/vault/a.md")).toBe(true);
    expect(saves.isDirty("/vault/b.md")).toBe(true);
  });

  it("moves edits made during a held rename to the new filesystem key", async () => {
    vi.useFakeTimers();
    const writes: TextSaveSnapshot<string>[] = [];
    const saves = coordinator(async (snapshot) => {
      writes.push(snapshot);
    });

    const hold = await saves.hold(["/vault/old.md"], true);
    saves.markDirty("/vault/old.md", "old.md", "new text", "disk text");
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toHaveLength(0);

    hold.move("/vault/old.md", "/vault/new.md", "new.md");
    await saves.flushAll();

    expect(writes).toMatchObject([
      {
        key: "/vault/new.md",
        target: "new.md",
        content: "new text",
        expectedContent: "disk text",
      },
    ]);
    expect(saves.isDirty("/vault/old.md")).toBe(false);
    expect(saves.isDirty("/vault/new.md")).toBe(false);
  });

  it("makes lifecycle flushes wait for a held filesystem operation", async () => {
    const writes: string[] = [];
    const saves = coordinator(async (snapshot) => {
      writes.push(snapshot.key);
    });
    const hold = await saves.hold(["/vault/a.md"], true);
    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    let flushed = false;
    const flush = saves.flushAll().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(writes).toHaveLength(0);
    hold.release();
    await flush;

    expect(writes).toEqual(["/vault/a.md"]);
    expect(flushed).toBe(true);
  });

  it("refuses overlapping hold owners for one filesystem key", async () => {
    const saves = coordinator(async () => undefined);
    const first = await saves.hold(["/vault/a.md"], false);

    await expect(saves.hold(["/vault/a.md"], false)).rejects.toThrow(
      "already held"
    );
    first.release();
  });

  it("continues unrelated queued writes after one path fails", async () => {
    const completed: string[] = [];
    const saves = coordinator(async (snapshot) => {
      if (snapshot.key.endsWith("a.md")) throw new Error("A failed");
      completed.push(snapshot.key);
    });
    saves.markDirty("/vault/a.md", "a.md", "A1", "A0");
    saves.markDirty("/vault/b.md", "b.md", "B1", "B0");

    await expect(saves.flushAll()).rejects.toThrow("A failed");

    expect(completed).toEqual(["/vault/b.md"]);
    expect(saves.isDirty("/vault/a.md")).toBe(true);
    expect(saves.isDirty("/vault/b.md")).toBe(false);
  });

  it("treats identical relative paths in different vaults as different files", async () => {
    const writes: string[] = [];
    const saves = coordinator(async (snapshot) => {
      writes.push(snapshot.key);
    });

    saves.markDirty("/vault-one/note.md", "note.md", "one", "old one");
    saves.markDirty("/vault-two/note.md", "note.md", "two", "old two");
    await saves.flushAll();

    expect(writes).toEqual(["/vault-one/note.md", "/vault-two/note.md"]);
  });
});

describe('save visibility and long sessions', () => {
  it('publishes pending, saving, failed and recovered states without per-keystroke chatter', async () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const write = vi.fn(async () => {});
    const saves = new TextSaveCoordinator<string>({ delayMs: 500, write, onStateChange });
    saves.markDirty('a', 'a', 'one', ''); saves.markDirty('a', 'a', 'two', '');
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith({ pending: 1, saving: 0, failed: 0 });
    write.mockRejectedValueOnce(new Error('offline'));
    await expect(saves.flushAll()).rejects.toThrow('offline');
    expect(onStateChange).toHaveBeenLastCalledWith({ pending: 1, saving: 0, failed: 1 });
    await saves.flushAll();
    expect(onStateChange).toHaveBeenLastCalledWith({ pending: 0, saving: 0, failed: 0 });
    expect(onStateChange.mock.calls.some(([state]) => state.saving === 1)).toBe(true);
  });
  it('releases entries and timers after 2000 edit/save cycles', async () => {
    vi.useFakeTimers();
    const saves = coordinator(async () => {});
    for (let i = 0; i < 2000; i++) { saves.markDirty(`file-${i}`, `file-${i}`, 'new', 'old'); await saves.flushAll(); }
    expect(saves.pendingCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
