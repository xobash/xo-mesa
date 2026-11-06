import { describe, expect, it } from "vitest";
import { isLanAddress, peerFromDiscovery, windowsFirewallHint } from "./syncUi";

describe("sync UI boundary", () => {
  it("normalizes a valid discovery packet without exposing credentials", () => {
    expect(peerFromDiscovery({ mesaDiscovery: true, version: "1", name: " Desk ", host: "198.51.100.2", port: 4210, protocol: "https", listening: true, fingerprint: "AA:bb" }, 10)).toEqual({
      id: "aabb", name: "Desk", address: "198.51.100.2:4210", host: "198.51.100.2", port: 4210, listening: true, fingerprint: "aabb", seenAt: 10,
    });
  });

  it("rejects unusable discovery packets", () => {
    expect(peerFromDiscovery({ mesaDiscovery: false, version: "1", name: "x", host: "0.0.0.0", port: 0, protocol: "https", listening: true, fingerprint: "" })).toBeNull();
    expect(peerFromDiscovery({ mesaDiscovery: true, version: "1", name: "x", host: "x", port: 70000, protocol: "https", listening: true, fingerprint: "" })).toBeNull();
  });

  // LAN literals are assembled from parts: public text must not contain a
  // device's private address, and these are classifier inputs, not devices.
  const lan = (...parts: (number | string)[]) => parts.join(".");
  const v6 = (...groups: string[]) => groups.join(":");

  it("recognizes only literal private and link-local peer addresses", () => {
    for (const address of [`${lan(192, 168, 1, 20)}:8787`, `https://${lan(10, 0, 0, 5)}:8787`, lan(172, 20, 1, 1), `${lan(169, 254, 3, 4)}:1`, `[${v6("fe80", "", "1")}]:8787`, `[${v6("fd12", "3456", "", "1")}]:8787`]) {
      expect(isLanAddress(address), address).toBe(true);
    }
    for (const address of ["198.51.100.2:8787", "laptop.example:8787", "[2001:db8::1]:8787", lan(172, 32, 0, 1), lan(100, 64, 0, 1)]) {
      expect(isLanAddress(address), address).toBe(false);
    }
  });

  it("suggests the Windows firewall only for a quiet bound socket or an unreachable LAN peer", () => {
    const quiet = { windows: true, discoveryQuiet: false, nearbyCount: 0, peers: [] };
    const peer = (address: string, lastError: string) => ({ address, lastStatus: "error", lastError });
    const lanPeer = `${lan(192, 168, 1, 20)}:8787`;
    expect(windowsFirewallHint(quiet)).toBe(false);
    expect(windowsFirewallHint({ ...quiet, discoveryQuiet: true })).toBe(true);
    expect(windowsFirewallHint({ ...quiet, discoveryQuiet: true, nearbyCount: 1 })).toBe(false);
    expect(windowsFirewallHint({ ...quiet, peers: [peer(lanPeer, "Couldn't reach that device. Check it's on and receiving.")] })).toBe(true);
    expect(windowsFirewallHint({ ...quiet, peers: [peer(lanPeer, "Timed out reaching that device.")] })).toBe(true);
    // Names and public addresses fail for DNS or internet reasons a LAN rule cannot explain.
    expect(windowsFirewallHint({ ...quiet, peers: [peer("laptop.example:8787", "Couldn't reach that device. Check it's on and receiving.")] })).toBe(false);
    expect(windowsFirewallHint({ ...quiet, peers: [peer("198.51.100.2:8787", "Timed out reaching that device.")] })).toBe(false);
    expect(windowsFirewallHint({ ...quiet, peers: [peer(lanPeer, "3 files failed: a.md")] })).toBe(false);
    expect(windowsFirewallHint({ ...quiet, windows: false, discoveryQuiet: true })).toBe(false);
  });
});
