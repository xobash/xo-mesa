import { describe, it, expect } from "vitest";
import {
  encodePairing,
  decodePairing,
  isPairingCode,
  isIpv4,
  parsePeerInput,
} from "./pairing";
import { peerFromDiscovery } from "./sync";

describe("pairing codes", () => {
  it("round-trips IPv4 + port", () => {
    const cases: [string, number][] = [
      ["192.168.1.5", 8787],
      ["10.0.0.1", 1],
      ["255.255.255.255", 65535],
      ["0.0.0.0", 0],
      ["100.115.92.3", 8787], // Tailscale-range IP
    ];
    for (const [host, port] of cases) {
      const code = encodePairing(host, port);
      expect(code).toBeTruthy();
      expect(decodePairing(code!)).toEqual({ host, port });
    }
  });

  it("produces a short grouped code for the default port", () => {
    const code = encodePairing("192.168.1.5", 8787)!;
    expect(code).toMatch(/^#[0-9A-Z]{3}-[0-9A-Z]{4}$/);
  });

  it("keeps a grouped 10-char code for custom ports", () => {
    const code = encodePairing("192.168.1.5", 9000)!;
    expect(code).toMatch(/^#[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
    expect(decodePairing(code)).toEqual({ host: "192.168.1.5", port: 9000 });
  });

  it("decodes tolerantly (lower case, spaces, look-alikes)", () => {
    const code = encodePairing("192.168.1.5", 8787)!;
    const messy = code.toLowerCase().replace(/-/g, " ");
    expect(decodePairing(messy)).toEqual({ host: "192.168.1.5", port: 8787 });
  });

  it("rejects non-IPv4 hosts for encoding", () => {
    expect(encodePairing("my-mac", 8787)).toBeNull();
    expect(encodePairing("192.168.1", 8787)).toBeNull();
    expect(encodePairing("192.168.1.5", 70000)).toBeNull();
  });

  it("isIpv4 distinguishes literals from names", () => {
    expect(isIpv4("192.168.1.5")).toBe(true);
    expect(isIpv4("256.1.1.1")).toBe(false);
    expect(isIpv4("my-mac")).toBe(false);
  });

  it("isPairingCode rejects addresses", () => {
    expect(isPairingCode("192.168.1.5:8787")).toBe(false);
    expect(isPairingCode("my-mac")).toBe(false);
    expect(isPairingCode(encodePairing("192.168.1.5", 8787)!)).toBe(true);
  });
});

describe("parsePeerInput", () => {
  it("decodes a pairing code to host:port", () => {
    const code = encodePairing("192.168.1.5", 8787)!;
    expect(parsePeerInput(code)).toBe("192.168.1.5:8787");
  });

  it("decodes short codes with the caller's default port", () => {
    const code = encodePairing("192.168.1.5", 9001, 9001)!;
    expect(parsePeerInput(code, 9001)).toBe("192.168.1.5:9001");
  });

  it("passes through host:port and adds the default port", () => {
    expect(parsePeerInput("192.168.1.5:9000")).toBe("192.168.1.5:9000");
    expect(parsePeerInput("my-mac")).toBe("my-mac:8787");
    expect(parsePeerInput("http://10.0.0.2:8787/")).toBe("http://10.0.0.2:8787");
  });

  it("returns null for empty input", () => {
    expect(parsePeerInput("   ")).toBeNull();
  });
});

describe("sync LAN discovery", () => {
  it("normalizes a Mesa discovery packet to an addable peer", () => {
    expect(
      peerFromDiscovery(
        {
          mesaDiscovery: true,
          version: "1.0",
          name: "Studio Mac",
          host: "192.168.1.12",
          port: 8787,
          protocol: "https",
          listening: true,
          fingerprint: "AB:CD:EF:12",
        },
        123
      )
    ).toEqual({
      id: "abcdef12",
      name: "Studio Mac",
      address: "192.168.1.12:8787",
      host: "192.168.1.12",
      port: 8787,
      listening: true,
      fingerprint: "abcdef12",
      seenAt: 123,
    });
  });

  it("rejects malformed discovery packets", () => {
    expect(
      peerFromDiscovery({
        mesaDiscovery: true,
        version: "1.0",
        name: "Bad",
        host: "0.0.0.0",
        port: 8787,
        protocol: "http",
        listening: true,
        fingerprint: "bad",
      })
    ).toBeNull();
  });
});
