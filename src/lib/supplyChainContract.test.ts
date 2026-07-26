import { describe, expect, it } from "vitest";
import packageLockText from "../../package-lock.json?raw";

const packageLock = JSON.parse(packageLockText) as {
  packages: Record<string, { version?: string }>;
};

function isAtLeast(version: string, minimum: [number, number, number]): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  const [minMajor, minMinor, minPatch] = minimum;

  return (
    major > minMajor ||
    (major === minMajor && minor > minMinor) ||
    (major === minMajor && minor === minMinor && patch >= minPatch)
  );
}

describe("JavaScript supply-chain contract", () => {
  it("keeps PostCSS above the path-traversal advisory range", () => {
    const version = packageLock.packages["node_modules/postcss"]?.version;

    expect(version).toBeDefined();
    expect(isAtLeast(version!, [8, 5, 18])).toBe(true);
  });
});
