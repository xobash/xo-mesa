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

function installedName(key: string): string {
  const marker = "node_modules/";
  const at = key.lastIndexOf(marker);
  return at === -1 ? key : key.slice(at + marker.length);
}

function hasPackage(pattern: string): boolean {
  return packageNames.some((key) => {
    const name = installedName(key);
    return pattern.endsWith("/") ? name.startsWith(pattern) : name === pattern;
  });
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

  it("keeps every source-map-js install above GHSA-68fv-2mgg-jv7q", () => {
    const installs = packageNames.filter((key) => installedName(key) === "source-map-js");
    expect(installs.length).toBeGreaterThan(0);
    for (const key of installs) {
      expect(isAtLeast(packageLock.packages[key].version ?? "0.0.0", [1, 2, 2])).toBe(true);
    }
  });

  it("keeps linkify-it above the quadratic scan advisory range", () => {
    const version = packageLock.packages["node_modules/linkify-it"]?.version;

    expect(version).toBeDefined();
    expect(isAtLeast(version!, [5, 0, 2])).toBe(true);
  });

  it("keeps Markdown linkification and test HTTP transport outside known DoS ranges", () => {
    const markdown = packageLock.packages["node_modules/markdown-it"]?.version ?? "0.0.0";
    expect((markdown.startsWith("14.") && isAtLeast(markdown, [14, 3, 1])) || isAtLeast(markdown, [15, 0, 1])).toBe(true);
    const undici = packageLock.packages["node_modules/undici"]?.version ?? "0.0.0";
    expect((undici.startsWith("7.") && isAtLeast(undici, [7, 29, 1])) || isAtLeast(undici, [8, 10, 2])).toBe(true);
  });

  it("does not include recent compromised-package watchlist families", () => {
    const watchlistPrefixes = [
      "chalk",
      "ansi-styles",
      "@ctrl/tinycolor",
      "@tanstack/",
      "@mistralai/",
      "nx",
      "prettier",
    ];

    for (const prefix of watchlistPrefixes) {
      expect(hasPackage(prefix)).toBe(false);
    }
  });

  it("checks nested installs as well as top-level packages", () => {
    expect(installedName("node_modules/a/node_modules/chalk")).toBe("chalk");
    expect(installedName("node_modules/@tanstack/query-core")).toBe("@tanstack/query-core");
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

  it("keeps the terminal dependency outside the old serial line", () => {
    expect(cargoPackageBlocks("serial")).toHaveLength(0);
    expect(cargoPackageBlocks("portable-pty").some((block) => cargoBlockVersion(block) === "0.9.0")).toBe(true);
  });
});
