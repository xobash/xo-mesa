import { describe, expect, it } from "vitest";
import { DEVICE_NAME_WORDS, generateDeviceName } from "./deviceName";

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
    const { adjectives, nouns } = DEVICE_NAME_WORDS;
    expect(generateDeviceName(() => 0)).toBe(`${adjectives[0]} ${nouns[0]}`);
    // rand → just under 1 must clamp to the last entries, never undefined.
    expect(generateDeviceName(() => 0.999999999)).toBe(
      `${adjectives[adjectives.length - 1]} ${nouns[nouns.length - 1]}`
    );
  });

  it("has a useful combination space (collisions between 2 devices unlikely)", () => {
    const { adjectives, nouns } = DEVICE_NAME_WORDS;
    expect(adjectives.length * nouns.length).toBeGreaterThan(2000);
    // No accidental duplicate words inside a list.
    expect(new Set(adjectives).size).toBe(adjectives.length);
    expect(new Set(nouns).size).toBe(nouns.length);
  });
});
