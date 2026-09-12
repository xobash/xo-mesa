import { describe, expect, it } from "vitest";
import overlaySrc from "../components/Overlay.tsx?raw";
import overlayDoc from "../../docs/overlay.md?raw";
import {
  LOCAL_NOTE_MAX_BYTES,
  isQuotaError,
  localNoteBytes,
  localNoteWriteMessage,
  readLocalNote,
  writeLocalNote,
  type LocalNoteStore,
} from "./localNotes";

/** A Storage double with a byte ceiling, so the quota path is exercised for
 *  real rather than mocked at the call site. */
function store(limitBytes = Infinity): LocalNoteStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      let used = 0;
      for (const [key, val] of map) {
        if (key !== k) used += key.length * 2 + val.length * 2;
      }
      if (used + k.length * 2 + v.length * 2 > limitBytes) {
        const err = new Error("exceeded the quota");
        err.name = "QuotaExceededError";
        throw err;
      }
      map.set(k, v);
    },
  };
}

describe("localNoteBytes", () => {
  it("counts UTF-16 code units, which is what the quota bills", () => {
    expect(localNoteBytes("")).toBe(0);
    expect(localNoteBytes("abc")).toBe(6);
    // An emoji is a surrogate pair: two code units, four bytes — not one.
    expect(localNoteBytes("🙂")).toBe(4);
  });
});

describe("isQuotaError", () => {
  it("recognizes the quota failure on every engine Mesa ships on", () => {
    // Mesa runs on WebView2 (Windows), WKWebView (macOS) and WebKitGTK
    // (Linux). Matching one engine's spelling makes the warning appear on one
    // OS and silently vanish on the others.
    for (const name of [
      "QuotaExceededError",
      "QUOTA_EXCEEDED_ERR",
      "NS_ERROR_DOM_QUOTA_REACHED",
    ]) {
      const err = new Error("full");
      err.name = name;
      expect(isQuotaError(err), name).toBe(true);
    }
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError({ code: 1014 })).toBe(true);
  });

  it("does not claim unrelated failures are a full disk", () => {
    expect(isQuotaError(new Error("SecurityError"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError("QuotaExceededError")).toBe(false);
    expect(isQuotaError({ code: 21 })).toBe(false);
  });
});

describe("writeLocalNote", () => {
  it("writes and reads back through the injected store", () => {
    const s = store();
    expect(writeLocalNote("mesa:scratch:2026-07-30", "hello", s)).toEqual({ ok: true });
    expect(readLocalNote("mesa:scratch:2026-07-30", s)).toBe("hello");
  });

  it("reports a full quota instead of losing the write in silence", () => {
    const s = store(40);
    const result = writeLocalNote("mesa:whiteboard", "x".repeat(500), s);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "quota" });
    expect(localNoteWriteMessage(result)).toMatch(/wasn't kept/i);
  });

  it("leaves the previous value intact when a write is refused", () => {
    // The user still has what they had. A partial or cleared entry would be
    // worse than the failure itself.
    const s = store(80);
    expect(writeLocalNote("mesa:whiteboard", "keep me", s).ok).toBe(true);
    expect(writeLocalNote("mesa:whiteboard", "y".repeat(500), s).ok).toBe(false);
    expect(readLocalNote("mesa:whiteboard", s)).toBe("keep me");
  });

  it("refuses an oversized entry before it can crowd out the app's own keys", () => {
    // Every `mesa:` key shares one origin quota. An unbounded whiteboard PNG
    // could evict `mesa:settings` / `mesa:theme` / `mesa:recentVaults` — the
    // user's vault list lost to a doodle. Refuse the doodle instead.
    const s = store();
    const huge = "z".repeat(LOCAL_NOTE_MAX_BYTES / 2 + 1);
    const result = writeLocalNote("mesa:whiteboard", huge, s);
    expect(result).toMatchObject({ reason: "too-large" });
    expect(s.map.has("mesa:whiteboard")).toBe(false);
    expect(localNoteWriteMessage(result)).toMatch(/too large/i);
  });

  it("accepts an entry exactly at the ceiling", () => {
    const s = store();
    expect(writeLocalNote("k", "z".repeat(LOCAL_NOTE_MAX_BYTES / 2), s).ok).toBe(true);
  });

  it("degrades to a clear result when there is no storage at all", () => {
    // Private mode, a sandboxed webview, storage disabled by policy.
    const result = writeLocalNote("k", "v", null);
    expect(result).toMatchObject({ reason: "unavailable" });
    expect(readLocalNote("k", null)).toBe("");
    expect(localNoteWriteMessage(result)).toMatch(/unavailable/i);
  });

  it("treats a non-quota throw as unavailable rather than as a full quota", () => {
    const s: LocalNoteStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("SecurityError: access denied");
      },
    };
    expect(writeLocalNote("k", "v", s)).toMatchObject({ reason: "unavailable" });
  });
});

describe("overlay scratch surfaces route through this module", () => {
  it("Overlay.tsx no longer swallows a failed browser-storage write", () => {
    // The regression this replaces: `catch { /* ignore */ }` around
    // `localStorage.setItem`, so a full quota lost the user's drawing with no
    // signal at all.
    expect(overlaySrc).toContain("writeLocalNote");
    expect(overlaySrc).toContain("localNoteWriteMessage");
    expect(overlaySrc).not.toMatch(/localStorage\.setItem/);
  });

  it("the public overlay contract names browser-storage writers and limits", () => {
    // Scratchpad and Whiteboard are user content, but they are deliberately
    // outside the vault. Keep that boundary in a public product document so
    // clones and release builds do not depend on private workspace material.
    for (const key of [
      "mesa:overlayWins",
      "mesa:scratch:",
      "mesa:whiteboard",
    ]) {
      expect(overlayDoc, `${key} should be documented`).toContain(key);
    }
    // …and the doc has to say what the weaker guarantee actually costs.
    expect(overlayDoc).toContain("src/lib/localNotes.ts");
    // Whitespace-tolerant: the doc is hard-wrapped, so the sentence can break
    // across lines without that meaning the guarantee went missing.
    expect(overlayDoc).toMatch(/does not sync/i);
  });
});
