import { describe, expect, it } from "vitest";
import type { GraphLink, GraphNode, VaultFile } from "../types";
import { buildGraph, buildNotes, type GraphFilterOptions } from "./graph";
import { isTextualVaultFile, toVaultFile } from "./vault";

const ROOT = "/vault";
const OFF: GraphFilterOptions = { showTags: false, existingOnly: true, showOrphans: false, showAttachments: false };
const ALL: GraphFilterOptions = { ...OFF, showAllFiles: true };

/** A catalog shaped exactly as `scanVault` publishes it, plus note metadata
 *  for the text files that the index has read. */
function vault(entries: Record<string, string>, unread: readonly string[] = []) {
  const files: VaultFile[] = Object.keys(entries)
    .sort((a, b) => a.localeCompare(b))
    .map((rel) => toVaultFile(ROOT, rel));
  const read = new Set(files.filter((f) => isTextualVaultFile(f) && !unread.includes(f.relPath)).map((f) => f.relPath));
  return { files, notes: buildNotes(files, new Map(Object.entries(entries)), read) };
}

const fileNodeIds = (nodes: GraphNode[]) =>
  nodes.filter((n) => n.kind === "note" || n.kind === "attachment").map((n) => n.id).sort();
const catalogIds = (files: VaultFile[]) => files.map((f) => f.relPath).sort();
const endId = (e: GraphLink["source"]) => (typeof e === "string" ? e : e.id);
const hasLink = (links: GraphLink[], source: string, target: string) =>
  links.some((l) => endId(l.source) === source && endId(l.target) === target);

/** One of every kind of file a vault can hold. */
const EVERY_KIND: Record<string, string> = {
  "Home.md": "links [[Ideas]]",
  "Ideas.md": "back to [[Home]]",
  "Lonely.md": "no links at all",
  "notes/plain.txt": "plain text",
  "data/table.csv": "a,b\n1,2",
  "data/config.json": "{}",
  "site/page.html": "<p>hi</p>",
  "letters/memo.rtf": "{\\rtf1 memo}",
  "assets/photo.png": "",
  "assets/diagram.svg": "<svg/>",
  "papers/study.pdf": "",
  "media/clip.mp4": "",
  "media/voice.mp3": "",
  "office/report.docx": "",
  "office/budget.xlsx": "",
  "office/deck.pptx": "",
  "archive/backup.zip": "",
  "bin/blob.bin": "",
  "bin/data.unknownext": "",
  "Makefile": "",
  "tools/LICENSE": "",
  "trailing.": "",
  "deep/a/b/c/d/e/f/g/leaf.md": "",
  "Ünïcode ñame.md": "",
  "spaced name/with space.pdf": "",
  "same/photo.png": "",
};

describe("All files graph filter", () => {
  it("makes every cataloged file a node, whatever the other filters say", () => {
    const { files, notes } = vault(EVERY_KIND, ["data/config.json"]);
    const { nodes } = buildGraph(notes, files, ALL);
    expect(fileNodeIds(nodes)).toEqual(catalogIds(files));
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it("keeps every file on a large generated catalog", () => {
    const exts = ["md", "png", "pdf", "docx", "zip", "bin", "", "csv", "mp3", "txt"];
    const entries: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) {
      const ext = exts[i % exts.length];
      entries[`f${i % 37}/n${i}${ext ? `.${ext}` : ""}`] = i % 3 === 0 ? `[[n${i + 1}]]` : "";
    }
    const { files, notes } = vault(entries);
    expect(fileNodeIds(buildGraph(notes, files, ALL).nodes)).toEqual(catalogIds(files));
  });

  it("is off by default and leaves the Obsidian filters unchanged", () => {
    const { files, notes } = vault(EVERY_KIND);
    expect(fileNodeIds(buildGraph(notes, files).nodes)).toEqual(
      catalogIds(files).filter((id) => /\.md$/.test(id))
    );
    const attachments = buildGraph(notes, files, { ...OFF, showOrphans: true, showAttachments: true });
    // Obsidian's Attachments filter draws every attachment in one colour.
    expect(attachments.nodes.every((n) => n.fileGroup === undefined)).toBe(true);
  });

  it("labels files by their real name, including files with no extension", () => {
    const { files, notes } = vault(EVERY_KIND);
    const byId = new Map(buildGraph(notes, files, ALL).nodes.map((n) => [n.id, n]));
    expect(byId.get("Makefile")?.title).toBe("Makefile");
    expect(byId.get("tools/LICENSE")?.title).toBe("LICENSE");
    expect(byId.get("trailing.")?.title).toBe("trailing.");
    expect(byId.get("papers/study.pdf")?.title).toBe("study.pdf");
  });

  it("gives non-note files a kind group for their colour", () => {
    const { files, notes } = vault(EVERY_KIND);
    const group = new Map(buildGraph(notes, files, ALL).nodes.map((n) => [n.id, n.fileGroup]));
    expect(group.get("assets/photo.png")).toBe("image");
    expect(group.get("papers/study.pdf")).toBe("pdf");
    expect(group.get("media/clip.mp4")).toBe("media");
    expect(group.get("media/voice.mp3")).toBe("media");
    expect(group.get("office/report.docx")).toBe("office");
    expect(group.get("office/budget.xlsx")).toBe("office");
    expect(group.get("archive/backup.zip")).toBe("archive");
    expect(group.get("bin/blob.bin")).toBe("other");
    expect(group.get("Makefile")).toBe("other");
    // Text documents are notes and keep the note fill.
    expect(group.get("Home.md")).toBeUndefined();
    expect(group.get("data/table.csv")).toBeUndefined();
  });
});

describe("links into non-note files", () => {
  const LINKS: Record<string, string> = {
    "notes/Trip.md": [
      "![[photo.png]]",
      "[plan](../papers/plan.pdf)",
      "![map](./map.webp)",
      "[[study.pdf#page=3]]",
      "[budget](</office/my budget.xlsx>)",
      "[deck](../office/deck%20final.pptx)",
      "[[Makefile]]",
      "[table](../data/table.csv)",
      "[web](https://example.com/x.pdf)",
    ].join("\n"),
    "notes/map.webp": "",
    "assets/photo.png": "",
    "papers/plan.pdf": "",
    "papers/study.pdf": "",
    "office/my budget.xlsx": "",
    "office/deck final.pptx": "",
    "tools/Makefile": "",
    "data/table.csv": "a,b",
  };

  it("turns embeds, Markdown links and relative paths into edges", () => {
    const { files, notes } = vault(LINKS);
    for (const opts of [ALL, { ...OFF, showAttachments: true }]) {
      const { links } = buildGraph(notes, files, opts);
      for (const target of [
        "assets/photo.png",
        "papers/plan.pdf",
        "notes/map.webp",
        "papers/study.pdf",
        "office/my budget.xlsx",
        "office/deck final.pptx",
        "tools/Makefile",
        "data/table.csv",
      ]) {
        expect(hasLink(links, "notes/Trip.md", target), target).toBe(true);
      }
    }
  });

  it("never turns a link to an existing file into an unresolved node", () => {
    const { files, notes } = vault(LINKS);
    const { nodes } = buildGraph(notes, files, { ...OFF, existingOnly: false, showOrphans: true });
    expect(nodes.filter((n) => n.kind === "phantom").map((n) => n.title)).toEqual([]);
  });

  it("does not climb above the vault root", () => {
    const { files, notes } = vault({ "a/Note.md": "[x](../../../outside.pdf)", "outside.pdf": "" });
    const { links } = buildGraph(notes, files, ALL);
    expect(links).toEqual([]);
  });
});
