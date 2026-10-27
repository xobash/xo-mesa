import { describe, expect, it } from "vitest";
import { generateDeviceName } from "./deviceName";

describe("generateDeviceName", () => {
  it("returns 'Adjective Noun' — two capitalized words", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateDeviceName()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    }
  });

  it("is deterministic for a given rand", () => {
    const rand = () => 0.5;
    expect(generateDeviceName(rand)).toBe(generateDeviceName(rand));
  });

  it("covers the edges of the word lists", () => {
    expect(generateDeviceName(() => 0)).toBe("Amber Acorn");
    // rand → just under 1 must clamp to the last entries, never undefined.
    expect(generateDeviceName(() => 0.999999999)).toBe("Zippy Zephyr");
  });

  it("has a useful combination space (collisions between 2 devices unlikely)", () => {
    const names = new Set<string>();
    for (let a = 0; a < 200; a++) {
      for (let n = 0; n < 200; n++) {
        const values = [a / 200, n / 200];
        names.add(generateDeviceName(() => values.shift()!));
      }
    }
    expect(names.size).toBeGreaterThan(2000);
  });
});
