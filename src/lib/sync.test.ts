import { describe, it, expect } from "vitest";
import {
  normalizePeer,
  normalizeFingerprint,
  formatFingerprint,
  peerFromDiscovery,
  mergeSyncLog,
  type DiscoveryPacket,
  type SyncLogEntry,
} from "./sync";

describe("normalizePeer", () => {
  it("defaults bare peers to HTTPS (sync is TLS-only)", () => {
    expect(normalizePeer("mac-mini:8787")).toBe("https://mac-mini:8787");
    expect(normalizePeer("mac-mini:8787", false)).toBe("http://mac-mini:8787");
  });

  it("preserves explicit schemes and strips trailing slashes", () => {
    expect(normalizePeer("https://peer.example/")).toBe("https://peer.example");
    expect(normalizePeer("http://203.0.113.5:8787/")).toBe(
      "http://203.0.113.5:8787"
    );
  });
});

describe("fingerprint helpers", () => {
  const FP = "A1:B2:c3:d4 e5f6";

  it("normalizes to bare lowercase hex", () => {
    expect(normalizeFingerprint(FP)).toBe("a1b2c3d4e5f6");
    expect(normalizeFingerprint(null)).toBe("");
    expect(normalizeFingerprint(undefined)).toBe("");
  });

  it("formats a short, colon-grouped, uppercase display form", () => {
    const hex = "aabbccddeeff00112233445566778899";
    expect(formatFingerprint(hex, 4)).toBe("AA:BB:CC:DD");
    expect(formatFingerprint("")).toBe("");
  });
});

describe("peerFromDiscovery", () => {
  const base: DiscoveryPacket = {
    mesaDiscovery: true,
    version: "1.0",
    name: "Studio iMac",
    host: "192.0.2.113",
    port: 8787,
    protocol: "https",
    listening: true,
    fingerprint: "AA:BB:CC:DD",
  };

  it("carries the certificate fingerprint and uses it as the stable id", () => {
    const peer = peerFromDiscovery(base, 1000);
    expect(peer).not.toBeNull();
    expect(peer!.fingerprint).toBe("aabbccdd");
    expect(peer!.id).toBe("aabbccdd");
    expect(peer!.address).toBe("192.0.2.113:8787");
  });

  it("falls back to address as id when no fingerprint is advertised", () => {
    const peer = peerFromDiscovery({ ...base, fingerprint: "" }, 1000);
    expect(peer!.id).toBe("192.0.2.113:8787");
    expect(peer!.fingerprint).toBe("");
  });

  it("rejects non-Mesa or unroutable packets", () => {
    expect(peerFromDiscovery({ ...base, mesaDiscovery: false })).toBeNull();
    expect(peerFromDiscovery({ ...base, host: "0.0.0.0" })).toBeNull();
  });
});

describe("mergeSyncLog", () => {
  const line = (msg: string): SyncLogEntry => ({ ts: 0, level: "info", msg });

  it("applies a coalesced batch in one pass, in order", () => {
    const batch = Array.from({ length: 300 }, (_, i) => line(`received ${i}`));
    const next = mergeSyncLog([line("start")], batch);
    expect(next).toHaveLength(301);
    expect(next[0].msg).toBe("start");
    expect(next[300].msg).toBe("received 299");
  });

  it("still accepts a lone entry (client-side logSyncLocal)", () => {
    expect(mergeSyncLog([line("a")], line("b")).map((l) => l.msg)).toEqual(["a", "b"]);
  });

  it("caps the retained log to the newest entries across the whole batch", () => {
    // A 4,000-file sync arriving as one batch must not blow past the cap.
    const cur = Array.from({ length: 800 }, (_, i) => line(`old ${i}`));
    const batch = Array.from({ length: 4000 }, (_, i) => line(`new ${i}`));
    const next = mergeSyncLog(cur, batch, 1000);
    expect(next).toHaveLength(1000);
    // Oldest survivors are the tail of the batch; nothing older leaks through.
    expect(next[0].msg).toBe("new 3000");
    expect(next[999].msg).toBe("new 3999");
  });

  it("returns the same array reference for an empty batch (no needless set)", () => {
    const cur = [line("a")];
    expect(mergeSyncLog(cur, [])).toBe(cur);
  });
});
