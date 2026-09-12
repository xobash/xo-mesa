import { describe, expect, it } from "vitest";
import cargoLockText from "../../src-tauri/Cargo.lock?raw";
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
  it("keeps Vitest and its mocker above GHSA-82fw-gwwq-j7x9", () => {
    for (const name of ["vitest", "@vitest/mocker"]) {
      const version = packageLock.packages[`node_modules/${name}`]?.version;
      expect(version).toBeDefined();
      expect(isAtLeast(version!, [4, 1, 11])).toBe(true);
    }
  });

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

function cargoPackageBlocks(name: string): string[] {
  return cargoLockText
    .split(/\n\[\[package\]\]\n/)
    .filter((block) => block.includes(`name = "${name}"`));
}

function cargoBlockVersion(block: string): string | null {
  return block.match(/version = "([^"]+)"/)?.[1] ?? null;
}

function cargoBlockDependencies(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("Rust supply-chain contract", () => {
  it("keeps the deprecated tiny_http TLS stack out of the lockfile", () => {
    const tinyHttp = cargoPackageBlocks("tiny_http");
    expect(tinyHttp).toHaveLength(1);
    expect(cargoBlockDependencies(tinyHttp[0]).some((dep) => dep.startsWith("rustls "))).toBe(
      false
    );

    expect(
      cargoPackageBlocks("rustls").some((block) => cargoBlockVersion(block) === "0.20.9")
    ).toBe(false);
    expect(
      cargoPackageBlocks("ring").some((block) => cargoBlockVersion(block) === "0.16.20")
    ).toBe(false);
  });
});
