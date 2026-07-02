import { describe, it, expect } from "vitest";
import {
  fnv1a,
  diffManifests,
  conflictName,
  normalizePeer,
  normalizeFingerprint,
  fingerprintsEqual,
  formatFingerprint,
  peerFromDiscovery,
  type ManifestEntry,
  type DiscoveryPacket,
} from "./sync";

const enc = (s: string) => new TextEncoder().encode(s);

describe("fnv1a", () => {
  it("is deterministic and 16 hex chars", () => {
    const a = fnv1a(enc("hello world"));
    expect(a).toBe(fnv1a(enc("hello world")));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs for different content", () => {
    expect(fnv1a(enc("a"))).not.toBe(fnv1a(enc("b")));
  });

  it("matches the known FNV-1a vector for the empty input", () => {
    // FNV-1a 64-bit offset basis
    expect(fnv1a(new Uint8Array())).toBe("cbf29ce484222325");
  });
});

describe("diffManifests", () => {
  const e = (rel: string, hash: string): ManifestEntry => ({
    rel,
    hash,
    size: hash.length,
  });

  it("pulls remote-only, pushes local-only, flags differing as conflicts", () => {
    const local = [e("a.md", "1"), e("b.md", "x"), e("local.md", "9")];
    const remote = [e("a.md", "1"), e("b.md", "y"), e("remote.md", "7")];
    const d = diffManifests(local, remote);
    expect(d.pull).toEqual(["remote.md"]);
    expect(d.push).toEqual(["local.md"]);
    expect(d.conflict).toEqual(["b.md"]);
  });

  it("does nothing when manifests match", () => {
    const m = [e("a.md", "1"), e("b.md", "2")];
    const d = diffManifests(m, [...m]);
    expect(d.pull).toEqual([]);
    expect(d.push).toEqual([]);
    expect(d.conflict).toEqual([]);
  });
});

describe("conflictName", () => {
  it("inserts a tag before the extension and strips host port/scheme", () => {
    const name = conflictName("sub/Note.md", "http://100.64.0.2:8787");
    expect(name).toMatch(/^sub\/Note \(conflict from 100\.64\.0\.2 \d{4}-\d{2}-\d{2}\)\.md$/);
  });

  it("appends a tag for extensionless names", () => {
    expect(conflictName("README", "host:1")).toMatch(/^README \(conflict from host /);
  });
});

describe("normalizePeer", () => {
  it("defaults bare peers to HTTPS (sync is TLS-only)", () => {
    expect(normalizePeer("mac-mini:8787")).toBe("https://mac-mini:8787");
    expect(normalizePeer("mac-mini:8787", false)).toBe("http://mac-mini:8787");
  });

  it("preserves explicit schemes and strips trailing slashes", () => {
    expect(normalizePeer("https://peer.example/")).toBe("https://peer.example");
    expect(normalizePeer("http://100.64.0.5:8787/")).toBe(
      "http://100.64.0.5:8787"
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

  it("compares fingerprints ignoring case and separators", () => {
    expect(fingerprintsEqual("a1b2c3", "A1:B2:C3")).toBe(true);
    expect(fingerprintsEqual("a1b2c3", "a1b2c4")).toBe(false);
    // Empty never equals empty — an unknown fingerprint is never "trusted".
    expect(fingerprintsEqual("", "")).toBe(false);
    expect(fingerprintsEqual(null, undefined)).toBe(false);
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
    host: "192.168.4.113",
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
    expect(peer!.address).toBe("192.168.4.113:8787");
  });

  it("falls back to address as id when no fingerprint is advertised", () => {
    const peer = peerFromDiscovery({ ...base, fingerprint: "" }, 1000);
    expect(peer!.id).toBe("192.168.4.113:8787");
    expect(peer!.fingerprint).toBe("");
  });

  it("rejects non-Mesa or unroutable packets", () => {
    expect(peerFromDiscovery({ ...base, mesaDiscovery: false })).toBeNull();
    expect(peerFromDiscovery({ ...base, host: "0.0.0.0" })).toBeNull();
  });
});
