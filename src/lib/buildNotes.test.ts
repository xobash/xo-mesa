import { describe, expect, it } from "vitest";
import { buildNotes } from "./graph";
import {
  extractFirstImage,
  extractLinks,
  extractLinksAndFirstImage,
} from "./markdownExtract";
import type { VaultFile } from "../types";

const file = (relPath: string, isMarkdown = true): VaultFile => ({
  path: `/v/${relPath}`,
  relPath,
  name: relPath.split("/").pop()!.replace(/\.(md|png)$/, ""),
  ext: relPath.split(".").pop()!,
  isMarkdown,
});

describe("extractLinksAndFirstImage", () => {
  const cases = [
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
