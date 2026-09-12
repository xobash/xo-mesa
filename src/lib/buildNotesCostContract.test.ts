import { describe, expect, it } from "vitest";
import { buildNotes } from "./graph";
import {
  extractLinks,
  extractFirstImage,
  extractLinksAndFirstImage,
} from "./markdownExtract";
import graphSource from "./graph.ts?raw";
import type { VaultFile } from "../types";

/**
 * `buildNotes` runs synchronously on the vault-open path, before the first
 * paint, over every markdown note in the vault — ~215 ms on the measured
 * 4,165-file vault. Two things it used to do were pure waste, and both are
 * invisible if they come back: a duplicate `[[wiki]]` regex pass (30 ms) and an
 * eager 4,165-file lookup index that the same vault consulted zero times
 * (32 ms). Together they were ~28% of the freeze.
 */

const file = (relPath: string, isMarkdown = true): VaultFile => ({
  path: `/v/${relPath}`,
  relPath,
  name: relPath.split("/").pop()!.replace(/\.(md|png)$/, ""),
  ext: relPath.split(".").pop()!,
  isMarkdown,
});

describe("extractLinksAndFirstImage: one wiki pass, identical results", () => {
  // Each case exercises a branch where the merged pass could diverge from the
  // two separate scans it replaces.
  const cases: string[] = [
    "",
    "plain prose with no refs at all",
    "a [[Note]] and a [[Other|aliased]] link",
    "embed ![[picture.png]] then a [[Note]]",
    "![[first.png]] and ![[second.jpg]] — only the first wins",
    "![[not-an-image.md]] is an embed but not an image",
    "[[]] empty target, [[ | ]] blank alias",
    "markdown image ![alt](assets/pic.png) with no wiki embed",
    "![alt](a.png) plus ![[b.png]] — the wiki embed takes priority",
    "[text](Some%20Note.md) encoded md link",
    "[ext](https://example.com/x.md) must not count",
    "![img](x.png) then [[Note]] then ![[y.gif]] mixed",
    "line1\n![[deep/nested/img.webp]]\nline2 [[A]] [[B]] [[C]]",
  ];

  it.each(cases)("matches the separate extractors for: %j", (src) => {
    const merged = extractLinksAndFirstImage(src);
    expect(merged.links).toEqual(extractLinks(src));
    expect(merged.firstImage).toEqual(extractFirstImage(src));
  });
});

describe("buildNotes", () => {
  it("still resolves a first embedded image to its vault path", () => {
    // The lazy index must produce exactly what the eager one did.
    const files = [file("note.md"), file("assets/pic.png", false)];
    const notes = buildNotes(
      files,
      new Map([["note.md", "text ![[pic.png]] more"]])
    );
    expect(notes["note.md"].firstImagePath).toBe("/v/assets/pic.png");
  });

  it("leaves firstImagePath undefined when no image is embedded", () => {
    const files = [file("note.md"), file("assets/pic.png", false)];
    const notes = buildNotes(files, new Map([["note.md", "just [[links]]"]]));
    expect(notes["note.md"].firstImagePath).toBeUndefined();
  });

  it("builds the lookup index lazily, not up front", () => {
    // Eagerly filling byName/byRel walked all 4,165 files doing three
    // `toLowerCase()` calls and a template concat each, for maps the measured
    // vault never read.
    expect(graphSource).toContain("let byName: Map<string, VaultFile> | null = null;");
    expect(graphSource).toContain("if (!byName) buildIndexes();");
    // The eager loop must not sit at the top of buildNotes any more.
    const body = graphSource.slice(
      graphSource.indexOf("export function buildNotes"),
      graphSource.indexOf("function sameStrings")
    );
    expect(body.indexOf("buildIndexes")).toBeLessThan(body.indexOf("for (const f of files)"));
  });

  it("takes links and the first image from ONE wiki scan", () => {
    expect(graphSource).toContain("extractLinksAndFirstImage(src)");
    expect(graphSource).not.toContain("extractFirstImage(src)");
  });
});
