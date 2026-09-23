import { describe, expect, it } from "vitest";
import { peerFromDiscovery } from "./syncUi";

describe("sync UI boundary", () => {
  it("normalizes a valid discovery packet without exposing credentials", () => {
    expect(peerFromDiscovery({ mesaDiscovery: true, version: "1", name: " Desk ", host: "192.168.1.2", port: 4210, protocol: "https", listening: true, fingerprint: "AA:bb" }, 10)).toEqual({
      id: "aabb", name: "Desk", address: "192.168.1.2:4210", host: "192.168.1.2", port: 4210, listening: true, fingerprint: "aabb", seenAt: 10,
    });
  });

  it("rejects unusable discovery packets", () => {
    expect(peerFromDiscovery({ mesaDiscovery: false, version: "1", name: "x", host: "0.0.0.0", port: 0, protocol: "https", listening: true, fingerprint: "" })).toBeNull();
    expect(peerFromDiscovery({ mesaDiscovery: true, version: "1", name: "x", host: "x", port: 70000, protocol: "https", listening: true, fingerprint: "" })).toBeNull();
  });
});
