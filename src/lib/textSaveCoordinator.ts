export interface TextSaveSnapshot<TTarget> {
  /** Stable filesystem identity. Mesa uses the canonical absolute file path. */
  key: string;
  target: TTarget;
  content: string;
  /** Exact disk text that the first unsaved edit was based on. */
  expectedContent: string;
  revision: number;
}

export interface TextSaveState {
  pending: number;
  saving: number;
  failed: number;
}

export interface TextSaveCoordinatorOptions<TTarget> {
  onStateChange?: (state: TextSaveState) => void;
  delayMs: number;
  write: (snapshot: TextSaveSnapshot<TTarget>) => Promise<void>;
  onError?: (
    snapshot: TextSaveSnapshot<TTarget>,
    error: unknown
  ) => void;
}

export interface TextSaveHold<TTarget> {
  /** Resume normal debounce behavior without changing any dirty entry. */
  release(): void;
  /** Forget every held entry after the caller successfully deletes its files. */
  discard(): void;
  /** Move one held filesystem identity after a successful atomic rename. */
  move(oldKey: string, newKey: string, newTarget: TTarget): void;
}

interface PendingTextSave<TTarget> {
  target: TTarget;
  baseline: string;
  content: string;
  revision: number;
  /** A rejected write makes the remembered disk baseline untrusted. */
  failed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
}

/**
 * Debounced, conflict-aware text saves keyed by filesystem identity.
 *
 * Each path owns its debounce state, so editing a second tab cannot cancel the
 * first tab's save. Writes share one queue to keep disk pressure bounded. If an
 * edit arrives during a write, the coordinator drains the newest revision only
 * after the first write succeeds and advances the expected disk baseline.
 */
export class TextSaveCoordinator<TTarget> {
  private readonly entries = new Map<string, PendingTextSave<TTarget>>();
  private readonly paused = new Set<string>();
  private readonly holdWaits = new Map<string, Promise<void>>();
  private lastState = "0:0:0";
  private publishState(): void {
    const state = { pending: this.entries.size, saving: 0, failed: 0 };
    for (const entry of this.entries.values()) {
      if (entry.running) state.saving++;
      if (entry.failed) state.failed++;
    }
    const key = `${state.pending}:${state.saving}:${state.failed}`;
    if (key === this.lastState) return;
    this.lastState = key;
    this.options.onStateChange?.(state);
  }

  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: TextSaveCoordinatorOptions<TTarget>) {}

  markDirty(
    key: string,
    target: TTarget,
    content: string,
    expectedContent: string
  ): void {
    if (!key) throw new Error("A text save requires a stable file key.");

    let entry = this.entries.get(key);
    if (!entry) {
      // Typing and then returning to the exact disk baseline is clean.
      if (content === expectedContent) return;
      entry = {
        target,
        baseline: expectedContent,
        content,
        revision: 1,
        failed: false,
        timer: null,
        running: null,
      };
      this.entries.set(key, entry);
    } else {
      entry.target = target;
      entry.content = content;
      entry.revision += 1;

      // This is safe only before a write starts. During a write, the disk can
      // advance to the in-flight snapshot, so returning to the older baseline
      // still needs a follow-up write.
      if (!entry.running && !entry.failed && content === entry.baseline) {
        this.clearTimer(entry);
        this.entries.delete(key);
        this.publishState();
        return;
      }
    }

    this.schedule(key, entry);
    this.publishState();
  }

  isDirty(key: string): boolean {
    return this.entries.has(key);
  }

  pendingCount(): number {
    return this.entries.size;
  }

  flush(key: string): Promise<void> {
    const held = this.holdWaits.get(key);
    if (held) return held.then(() => this.flush(key));
    return this.flushNow(key);
  }

  private flushNow(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    this.clearTimer(entry);
    if (entry.running) return entry.running;

    const running = this.drain(key, entry).finally(() => {
      if (entry.running === running) entry.running = null;
      this.publishState();
    });
    entry.running = running;
    this.publishState();
    return running;
  }

  async flushAll(): Promise<void> {
    // A close or vault switch is a quiescence boundary. Repeat so an edit that
    // creates a new path while an earlier path is flushing is included too.
    while (this.entries.size > 0 || this.holdWaits.size > 0) {
      const holds = [...new Set(this.holdWaits.values())];
      if (holds.length) {
        await Promise.all(holds);
        continue;
      }
      const keys = [...this.entries.keys()];
      const results = await Promise.allSettled(keys.map((key) => this.flush(key)));
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failed) throw failed.reason;
    }
  }

  /**
   * Hold filesystem identities across an async rename/delete operation.
   *
   * Every key is paused before waiting, so an edit that arrives while the
   * filesystem call is in progress cannot start a write under an obsolete
   * path. `flushPending` establishes a clean rename baseline. Delete passes
   * false: pending edits need not be written to a file the user is deleting,
   * but any write already in flight must settle before deletion can start.
   * Acquisition is atomic across keys: if one in-flight save fails, no pending
   * entry is discarded and every key resumes normally.
   */
  async hold(
    keys: Iterable<string>,
    flushPending: boolean
  ): Promise<TextSaveHold<TTarget>> {
    const heldKeys = [...new Set(keys)];
    const alreadyHeld = heldKeys.find((key) => this.holdWaits.has(key));
    if (alreadyHeld) {
      throw new Error(`Text save path is already held: ${alreadyHeld}`);
    }
    let resolveHold!: () => void;
    const holdComplete = new Promise<void>((resolve) => {
      resolveHold = resolve;
    });
    for (const key of heldKeys) {
      this.paused.add(key);
      this.holdWaits.set(key, holdComplete);
      const entry = this.entries.get(key);
      if (entry) this.clearTimer(entry);
    }

    const waits = flushPending
      ? heldKeys.map((key) => this.flushNow(key))
      : heldKeys.flatMap((key) => {
          const running = this.entries.get(key)?.running;
          return running ? [running] : [];
        });
    const results = await Promise.allSettled(waits);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failed) {
      this.resumeKeys(heldKeys);
      for (const key of heldKeys) this.holdWaits.delete(key);
      resolveHold();
      throw failed.reason;
    }

    let active = true;
    const finish = (schedule: boolean): void => {
      if (!active) return;
      active = false;
      if (schedule) this.resumeKeys(heldKeys);
      else for (const key of heldKeys) this.paused.delete(key);
      for (const key of heldKeys) this.holdWaits.delete(key);
      resolveHold();
    };
    return {
      release: () => finish(true),
      discard: () => {
        if (!active) return;
        for (const key of heldKeys) {
          const entry = this.entries.get(key);
          if (entry) this.clearTimer(entry);
          this.entries.delete(key);
        }
        finish(false);
        this.publishState();
      },
      move: (oldKey, newKey, newTarget) => {
        if (!active || !heldKeys.includes(oldKey)) {
          throw new Error("Text save path is not held for rename.");
        }
        if (this.entries.has(newKey)) {
          throw new Error("Renamed text save target is already dirty.");
        }
        const entry = this.entries.get(oldKey);
        if (entry?.running) {
          throw new Error("Cannot move a text save while its write is running.");
        }
        if (entry) {
          this.clearTimer(entry);
          this.entries.delete(oldKey);
          entry.target = newTarget;
          this.entries.set(newKey, entry);
        }
        this.paused.delete(oldKey);
        active = false;
        for (const key of heldKeys) {
          if (key !== oldKey) this.resumeKeys([key]);
          this.holdWaits.delete(key);
        }
        resolveHold();
        if (entry) this.schedule(newKey, entry);
      },
    };
  }

  async discard(keys: Iterable<string>): Promise<void> {
    const hold = await this.hold(keys, false);
    hold.discard();
  }

  private schedule(key: string, entry: PendingTextSave<TTarget>): void {
    this.clearTimer(entry);
    if (entry.running || this.paused.has(key)) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.flush(key).catch(() => undefined);
    }, this.options.delayMs);
  }

  private resumeKeys(keys: Iterable<string>): void {
    for (const key of keys) {
      this.paused.delete(key);
      const entry = this.entries.get(key);
      if (entry) this.schedule(key, entry);
    }
  }

  private clearTimer(entry: PendingTextSave<TTarget>): void {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  private enqueue(snapshot: TextSaveSnapshot<TTarget>): Promise<void> {
    const write = this.writeTail.then(() => this.options.write(snapshot));
    // A failed path must not poison the queue for unrelated notes.
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private async drain(
    key: string,
    entry: PendingTextSave<TTarget>
  ): Promise<void> {
    while (this.entries.get(key) === entry) {
      const snapshot: TextSaveSnapshot<TTarget> = {
        key,
        target: entry.target,
        content: entry.content,
        expectedContent: entry.baseline,
        revision: entry.revision,
      };
      try {
        await this.enqueue(snapshot);
      } catch (error) {
        entry.failed = true;
        this.options.onError?.(snapshot, error);
        throw error;
      }

      if (this.entries.get(key) !== entry) return;
      entry.failed = false;
      entry.baseline = snapshot.content;
      if (
        entry.revision === snapshot.revision ||
        entry.content === entry.baseline
      ) {
        this.entries.delete(key);
        this.publishState();
        return;
      }
    }
  }
}
