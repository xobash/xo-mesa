import { describe, it, expect } from "vitest";
import type { VaultFile } from "../types";
import {
  buildNotes,
  buildGraph,
  buildNeighbors,
  resolveTarget,
  backlinksFor,
  refreshedNoteMeta,
  resolveAssetPath,
} from "./graph";

function vf(relPath: string, isMarkdown = true): VaultFile {
  const base = relPath.split("/").pop() || relPath;
  const name = base.replace(/\.[^.]+$/, "");
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return { path: "/vault/" + relPath, relPath, name, ext, isMarkdown };
}

function makeVault(entries: Record<string, string>) {
  const files = Object.keys(entries).map((p) =>
    vf(p, /\.(md|markdown)$/i.test(p))
  );
  const contents = new Map(Object.entries(entries));
  return { files, notes: buildNotes(files, contents) };
}

describe("buildGraph", () => {
  it("builds nodes, directed links, and degree from wiki links", () => {
    const { notes, files } = makeVault({
      "A.md": "links [[B]]",
      "B.md": "links [[A]] and [[C]]",
      "C.md": "no links",
    });
    const { nodes, links } = buildGraph(notes, files);
    expect(nodes.map((n) => n.id).sort()).toEqual(["A.md", "B.md", "C.md"]);
    expect(links).toContainEqual({ source: "A.md", target: "B.md" });
    expect(links).toContainEqual({ source: "B.md", target: "C.md" });

    const deg = Object.fromEntries(nodes.map((n) => [n.id, n.degree]));
    expect(deg["A.md"]).toBe(2);
    expect(deg["B.md"]).toBe(3);
    expect(deg["C.md"]).toBe(1);
  });

  it("attaches a thumbnail path for the first embedded image", () => {
    const { notes, files } = makeVault({
      "Note.md": "intro ![[hero.png]]",
      "hero.png": "",
    });
    const { nodes } = buildGraph(notes, files);
    const node = nodes.find((n) => n.id === "Note.md")!;
    expect(node.thumbPath).toBe("/vault/hero.png");
  });

  it("includes markdown notes only by default", () => {
    const { notes, files } = makeVault({
      "Readme.md": "links [[Data]]",
      "Data.md": "",
      "Orphan.md": "no links here",
      "photo.png": "",
      "archive.zip": "",
      "doc.pdf": "",
      "script.ts": "",
    });
    const { nodes } = buildGraph(notes, files);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId).sort()).toEqual(["Data.md", "Orphan.md", "Readme.md"]);
    expect(byId["photo.png"]).toBeUndefined();
    expect(byId["archive.zip"]).toBeUndefined();
    expect(byId["doc.pdf"]).toBeUndefined();
    expect(byId["script.ts"]).toBeUndefined();
    // Notes keep their kind/degree; an unlinked note is an isolated node in the
    // same force simulation.
    expect(byId["Readme.md"].kind).toBe("note");
    expect(byId["Orphan.md"].degree).toBe(0);
    expect(byId["Readme.md"].degree).toBe(1);
    expect(byId["Data.md"].degree).toBe(1);
  });

  it("non-markdown files stay out of the graph", () => {
    const { notes, files } = makeVault({
      "Readme.md": "links [[Data]]",
      "Data.md": "",
      "Orphan.md": "no links here",
      "photo.png": "",
      "doc.pdf": "",
    });
    const { nodes } = buildGraph(notes, files, {
      showTags: false,
      existingOnly: true,
      showOrphans: true,
      showAttachments: false,
    });
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["Data.md", "Orphan.md", "Readme.md"]);
    for (const n of nodes) expect(n.kind).toBe("note");
  });

  it("Tags on adds #tag nodes with note→tag edges", () => {
    const { notes, files } = makeVault({
      "A.md": "#alpha #beta tagged",
      "B.md": "#alpha only",
    });
    const opts = {
      showTags: true,
      existingOnly: true,
      showOrphans: true,
      showAttachments: false,
    };
    const { nodes, links } = buildGraph(notes, files, opts);
    const tagNodes = nodes.filter((n) => n.kind === "tag");
    expect(tagNodes.map((n) => n.title).sort()).toEqual(["#alpha", "#beta"]);
    // #alpha is used by two notes → degree 2 (and it's a connected node).
    const alpha = tagNodes.find((n) => n.title === "#alpha")!;
    expect(alpha.degree).toBe(2);
    // Both notes are connected (to a tag), so neither is an orphan even though
    // B.md has no [[wiki-links]].
    const a = nodes.find((n) => n.id === "A.md")!;
    const b = nodes.find((n) => n.id === "B.md")!;
    expect(a.degree).toBeGreaterThan(0);
    expect(b.degree).toBeGreaterThan(0);
    // An edge connects a note to the tag node.
    const endId = (e: unknown) => (typeof e === "string" ? e : (e as { id: string }).id);
    expect(links.some((l) => endId(l.source) === "A.md" && endId(l.target) === alpha.id)).toBe(true);

    // Default (tags off) creates no tag nodes.
    const off = buildGraph(notes, files);
    expect(off.nodes.some((n) => n.kind === "tag")).toBe(false);
  });

  it("phantom nodes appear only when existingOnly is false", () => {
    const { notes, files } = makeVault({
      "A.md": "points at [[Ghost]] and [[Real]]",
      "Real.md": "exists",
    });
    // existingOnly true (default) → no phantom for the missing [[Ghost]].
    expect(buildGraph(notes, files).nodes.some((n) => n.kind === "phantom")).toBe(false);

    const { nodes, links } = buildGraph(notes, files, {
      showTags: false,
      existingOnly: false,
      showOrphans: true,
      showAttachments: false,
    });
    const ghost = nodes.find((n) => n.kind === "phantom");
    expect(ghost?.title).toBe("Ghost");
    const endId = (e: unknown) => (typeof e === "string" ? e : (e as { id: string }).id);
    expect(links.some((l) => endId(l.source) === "A.md" && endId(l.target) === ghost!.id)).toBe(true);
  });

  it("embeds and links to non-markdown files do not create graph nodes or links", () => {
    const { notes, files } = makeVault({
      "Hero.md": "intro ![[hero.png]] and a link [[doc.pdf]]",
      "hero.png": "",
      "doc.pdf": "",
    });
    const { nodes, links } = buildGraph(notes, files);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["Hero.md"].thumbPath).toBe("/vault/hero.png");
    expect(byId["hero.png"]).toBeUndefined();
    expect(byId["doc.pdf"]).toBeUndefined();
    const endId = (e: unknown) => (typeof e === "string" ? e : (e as { id: string }).id);
    expect(
      links.some((l) => endId(l.target) === "hero.png" || endId(l.target) === "doc.pdf")
    ).toBe(false);
  });

  it("Attachments on: linked and unlinked attachments are ordinary force nodes", () => {
    const { notes, files } = makeVault({
      "Hero.md": "read [[doc.pdf]] and [[assets/page.html]]",
      "doc.pdf": "",
      "assets/page.html": "",
      "styles.css": "",
      "photo.png": "",
    });
    const { nodes, links } = buildGraph(notes, files, {
      showTags: false,
      existingOnly: true,
      showOrphans: true,
      showAttachments: true,
    });
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    // Linked attachments: force nodes with degree ≥ 1.
    expect(byId["doc.pdf"].kind).toBe("attachment");
    expect(byId["doc.pdf"].degree).toBe(1);
    expect(byId["assets/page.html"].degree).toBe(1);
    const endId = (e: unknown) => (typeof e === "string" ? e : (e as { id: string }).id);
    expect(links.some((l) => endId(l.source) === "Hero.md" && endId(l.target) === "doc.pdf")).toBe(true);
    // Unlinked attachments: same node kind, zero degree — they join the same
    // force simulation as everything else (Obsidian behavior); repulsion
    // halos them around the cluster, no special static layout.
    expect(byId["styles.css"].kind).toBe("attachment");
    expect(byId["styles.css"].degree).toBe(0);
    // Image embeds (![[...]]) aren't wiki-links, so an embedded-only image
    // counts as an unlinked attachment.
    expect(byId["photo.png"].degree).toBe(0);
    // Titles show the full filename like Obsidian.
    expect(byId["doc.pdf"].title).toBe("doc.pdf");
  });

  it("Attachments off never phantoms links that resolve to real attachment files", () => {
    const { notes, files } = makeVault({
      "Hero.md": "read [[doc.pdf]] and missing [[Ghost]]",
      "doc.pdf": "",
    });
    const { nodes } = buildGraph(notes, files, {
      showTags: false,
      existingOnly: false, // phantoms enabled
      showOrphans: true,
      showAttachments: false,
    });
    const phantoms = nodes.filter((n) => n.kind === "phantom");
    // Ghost is a phantom; doc.pdf is NOT (the file exists, it's just hidden).
    expect(phantoms.map((n) => n.title)).toEqual(["Ghost"]);
    expect(nodes.some((n) => n.kind === "attachment")).toBe(false);
  });

  it("Orphans off hides unlinked attachments but keeps linked ones", () => {
    const { notes, files } = makeVault({
      "Hero.md": "read [[doc.pdf]]",
      "doc.pdf": "",
      "styles.css": "",
    });
    const { nodes } = buildGraph(notes, files, {
      showTags: false,
      existingOnly: true,
      showOrphans: false,
      showAttachments: true,
    });
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["Hero.md", "doc.pdf"]);
  });

  it("Orphans off drops unconnected notes", () => {
    const { notes, files } = makeVault({
      "Hub.md": "[[Leaf]]",
      "Leaf.md": "back",
      "Lonely.md": "no links at all",
      "photo.png": "",
    });
    const { nodes } = buildGraph(notes, files, {
      showTags: false,
      existingOnly: true,
      showOrphans: false,
      showAttachments: false,
    });
    const ids = nodes.map((n) => n.id).sort();
    // Orphan note (Lonely.md) is gone; non-markdown files are never graph nodes.
    expect(ids).toEqual(["Hub.md", "Leaf.md"]);
  });
});

describe("resolveTarget", () => {
  it("resolves by title, relpath, and frontmatter alias", () => {
    const { notes } = makeVault({
      "Foo.md": "---\naliases: [Bar]\n---\nhi",
      "sub/Deep.md": "x",
    });
    expect(resolveTarget(notes, "Foo")).toBe("Foo.md");
    expect(resolveTarget(notes, "Bar")).toBe("Foo.md"); // alias
    expect(resolveTarget(notes, "sub/Deep")).toBe("sub/Deep.md");
    expect(resolveTarget(notes, "Nope")).toBeNull();
  });
});

describe("backlinksFor", () => {
  it("lists notes that link to the target", () => {
    const { notes } = makeVault({
      "A.md": "[[Target]]",
      "B.md": "[[Target]] twice [[Target]]",
      "Target.md": "self",
      "C.md": "unrelated",
    });
    expect(backlinksFor(notes, "Target.md")).toEqual(["A.md", "B.md"]);
  });

  it("excludes a note's link to itself", () => {
    const { notes } = makeVault({
      "Loop.md": "[[Loop]] links to itself, and to [[Other]]",
      "Other.md": "[[Loop]]",
    });
    expect(backlinksFor(notes, "Loop.md")).toEqual(["Other.md"]);
    expect(backlinksFor(notes, "Other.md")).toEqual(["Loop.md"]);
  });

  it("cached index parity: matches the per-call scan on every note", () => {
    // Verbatim pre-index implementation (graph.ts before Round 4) as the
    // reference: the cached inverted index must answer identically for every
    // note id in the vault, including notes with no backlinks.
    const reference = (
      notes: ReturnType<typeof makeVault>["notes"],
      targetId: string
    ): string[] => {
      const out: string[] = [];
      for (const id of Object.keys(notes)) {
        if (id === targetId) continue;
        if (
          notes[id].rawLinks.some((r) => resolveTarget(notes, r) === targetId)
        )
          out.push(id);
      }
      return out.sort();
    };
    const { notes } = makeVault({
      "Hub.md": "[[A]] [[B]] [[sub/Deep]] [[Missing]]",
      "A.md": "[[Hub]] [[B|alias to b]] [[A]]",
      "B.md": "[[hub]] case-insensitive [[SUB/DEEP]]",
      "sub/Deep.md": "[[Hub]] [[A.md]]",
      "Lonely.md": "no links",
    });
    for (const id of Object.keys(notes)) {
      expect(backlinksFor(notes, id)).toEqual(reference(notes, id));
    }
  });

  it("index is keyed by notes identity: a replaced notes object re-indexes", () => {
    const first = makeVault({ "A.md": "[[Target]]", "Target.md": "" }).notes;
    expect(backlinksFor(first, "Target.md")).toEqual(["A.md"]);
    // Same shape the store produces: a fresh object with changed metadata.
    const second = makeVault({
      "A.md": "link removed",
      "B.md": "[[Target]]",
      "Target.md": "",
    }).notes;
    expect(backlinksFor(second, "Target.md")).toEqual(["B.md"]);
    // The first object's cached answer is untouched.
    expect(backlinksFor(first, "Target.md")).toEqual(["A.md"]);
  });
});

describe("refreshedNoteMeta", () => {
  const SRC = "---\naliases: [Alt Name]\n---\n# A\n\nSee [[B]] and [[C]]. #topic";
  const meta = () => makeVault({ "A.md": SRC, "B.md": "", "C.md": "" }).notes["A.md"];

  it("returns null when links, tags, and aliases are all unchanged", () => {
    // Prose-only edit: same metadata extracted from different text.
    const edited = SRC + "\n\nMore prose, no new links or tags.";
    expect(refreshedNoteMeta(meta(), edited)).toBeNull();
    // Identical text is trivially unchanged too.
    expect(refreshedNoteMeta(meta(), SRC)).toBeNull();
  });

  it("returns refreshed meta when a link is added, preserving other fields", () => {
    const cur = meta();
    const next = refreshedNoteMeta(cur, SRC + "\n\nAlso [[D]].");
    expect(next).not.toBeNull();
    expect(next!.rawLinks).toEqual(["B", "C", "D"]);
    // Untouched fields carry over — including title and relPath.
    expect(next!.title).toBe(cur.title);
    expect(next!.relPath).toBe(cur.relPath);
    expect(next!.tags).toEqual(cur.tags);
    expect(next!.aliases).toEqual(cur.aliases);
  });

  it("detects tag and alias changes", () => {
    expect(refreshedNoteMeta(meta(), SRC + " #another")).not.toBeNull();
    const aliasEdit = SRC.replace("[Alt Name]", "[Alt Name, Second]");
    expect(refreshedNoteMeta(meta(), aliasEdit)).not.toBeNull();
  });

  it("a removed link is a change (shorter arrays compare unequal)", () => {
    expect(refreshedNoteMeta(meta(), SRC.replace(" and [[C]]", ""))).not.toBeNull();
  });
});

describe("buildNeighbors", () => {
  it("builds symmetric neighbor sets from string-id links", () => {
    const nbrs = buildNeighbors([
      { source: "A.md", target: "B.md" },
      { source: "B.md", target: "C.md" },
    ]);
    expect([...(nbrs.get("A.md") ?? [])]).toEqual(["B.md"]);
    expect([...(nbrs.get("B.md") ?? [])].sort()).toEqual(["A.md", "C.md"]);
    expect([...(nbrs.get("C.md") ?? [])]).toEqual(["B.md"]);
    expect(nbrs.get("D.md")).toBeUndefined();
  });

  it("handles object endpoints (post-simulation links) and duplicates", () => {
    const a = { id: "A.md", title: "A", degree: 1, kind: "note", ext: "md" };
    const b = { id: "B.md", title: "B", degree: 1, kind: "note", ext: "md" };
    const nbrs = buildNeighbors([
      // d3's forceLink rewrites endpoints to node objects after binding.
      { source: a, target: b } as never,
      { source: "A.md", target: "B.md" },
    ]);
    expect([...(nbrs.get("A.md") ?? [])]).toEqual(["B.md"]);
    expect([...(nbrs.get("B.md") ?? [])]).toEqual(["A.md"]);
  });

  it("matches buildGraph output on a real vault", () => {
    const { notes, files } = makeVault({
      "A.md": "[[B]] [[C]]",
      "B.md": "",
      "C.md": "[[B]]",
      "Orphan.md": "no links",
    });
    const { links } = buildGraph(notes, files);
    const nbrs = buildNeighbors(links);
    expect([...(nbrs.get("A.md") ?? [])].sort()).toEqual(["B.md", "C.md"]);
    expect([...(nbrs.get("B.md") ?? [])].sort()).toEqual(["A.md", "C.md"]);
    expect(nbrs.get("Orphan.md")).toBeUndefined();
  });
});

describe("resolveAssetPath", () => {
  it("matches by relpath and by basename", () => {
    const files = [vf("assets/spark.svg", false), vf("Note.md")];
    expect(resolveAssetPath(files, "assets/spark.svg")).toBe(
      "/vault/assets/spark.svg"
    );
    expect(resolveAssetPath(files, "spark.svg")).toBe("/vault/assets/spark.svg");
    expect(resolveAssetPath(files, "missing.png")).toBeNull();
  });
});
