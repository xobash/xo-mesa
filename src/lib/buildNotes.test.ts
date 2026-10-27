import { describe, expect, it } from "vitest";
import { buildNotes } from "./graph";
import { extractLinks, extractLinksAndFirstImage } from "./markdownExtract";
import type { VaultFile } from "../types";

const file = (relPath: string, isMarkdown = true): VaultFile => ({
  path: `/v/${relPath}`,
  relPath,
  name: relPath.split("/").pop()!.replace(/\.(md|png)$/, ""),
  ext: relPath.split(".").pop()!,
  isMarkdown,
});

describe("extractLinksAndFirstImage", () => {
  const cases: [string, string | null][] = [
    ["", null],
    ["plain prose with no refs at all", null],
    ["a [[Note]] and a [[Other|aliased]] link", null],
    ["embed ![[picture.png]] then a [[Note]]", "picture.png"],
    ["![[first.png]] and ![[second.jpg]] — only the first wins", "first.png"],
    ["![[not-an-image.md]] is an embed but not an image", null],
    ["[[]] empty target, [[ | ]] blank alias", null],
    ["markdown image ![alt](assets/pic.png) with no wiki embed", "assets/pic.png"],
    ["![alt](a.png) plus ![[b.png]] — the wiki embed takes priority", "b.png"],
    ["[text](Some%20Note.md) encoded md link", null],
    ["[ext](https://example.com/x.md) must not count", null],
    ["![img](x.png) then [[Note]] then ![[y.gif]] mixed", "y.gif"],
    ["line1\n![[deep/nested/img.webp]]\nline2 [[A]] [[B]] [[C]]", "deep/nested/img.webp"],
  ];

  it.each(cases)("matches extractLinks and finds the first image in: %j", (src, firstImage) => {
    const merged = extractLinksAndFirstImage(src);
    expect(merged.links).toEqual(extractLinks(src));
    expect(merged.firstImage).toEqual(firstImage);
  });
});

describe("buildNotes", () => {
  it("resolves the first embedded image to its vault path", () => {
    const files = [file("note.md"), file("assets/pic.png", false)];
    const notes = buildNotes(files, new Map([["note.md", "text ![[pic.png]] more"]]));
    expect(notes["note.md"].firstImagePath).toBe("/v/assets/pic.png");
  });

  it("leaves firstImagePath undefined without an embedded image", () => {
    const files = [file("note.md"), file("assets/pic.png", false)];
    const notes = buildNotes(files, new Map([["note.md", "just [[links]]"]]));
    expect(notes["note.md"].firstImagePath).toBeUndefined();
  });
});
