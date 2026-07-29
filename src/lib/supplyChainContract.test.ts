import { describe, expect, it } from "vitest";
import packageLockText from "../../package-lock.json?raw";

const packageLock = JSON.parse(packageLockText) as {
  packages: Record<string, { version?: string }>;
};
const packageNames = Object.keys(packageLock.packages);

function isAtLeast(version: string, minimum: [number, number, number]): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  const [minMajor, minMinor, minPatch] = minimum;

  return (
    major > minMajor ||
    (major === minMajor && minor > minMinor) ||
    (major === minMajor && minor === minMinor && patch >= minPatch)
  );
}

function hasPackage(prefix: string): boolean {
  return packageNames.some((name) => name === prefix || name.startsWith(`${prefix}/`));
}

describe("JavaScript supply-chain contract", () => {
  it("keeps PostCSS above the path-traversal advisory range", () => {
    const version = packageLock.packages["node_modules/postcss"]?.version;

    expect(version).toBeDefined();
    expect(isAtLeast(version!, [8, 5, 18])).toBe(true);
  });

  it("keeps linkify-it above the quadratic scan advisory range", () => {
    const version = packageLock.packages["node_modules/linkify-it"]?.version;

    expect(version).toBeDefined();
    expect(isAtLeast(version!, [5, 0, 2])).toBe(true);
  });

  it("does not include recent compromised-package watchlist families", () => {
    const watchlistPrefixes = [
      "node_modules/chalk",
      "node_modules/ansi-styles",
      "node_modules/@ctrl/tinycolor",
      "node_modules/@tanstack/",
      "node_modules/@mistralai/",
      "node_modules/nx",
      "node_modules/eslint",
      "node_modules/prettier",
    ];

    for (const prefix of watchlistPrefixes) {
      expect(hasPackage(prefix)).toBe(false);
    }
  });
});
