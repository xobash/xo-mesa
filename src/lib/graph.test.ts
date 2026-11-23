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
  sameGraphTopology,
  sameGraphNotes,
  createGraphBuilder,
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

  it("carries file creation time for graph timelapse ordering", () => {
    const { notes, files } = makeVault({
      "Older.md": "",
      "Newer.md": "",
    });
    files.find((f) => f.relPath === "Older.md")!.createdAt = 1_700_000_000_000;
    files.find((f) => f.relPath === "Newer.md")!.createdAt = 1_800_000_000_000;
    const { nodes } = buildGraph(notes, files);
    expect(nodes.find((n) => n.id === "Older.md")!.timelineTime).toBe(1_700_000_000_000);
    expect(nodes.find((n) => n.id === "Newer.md")!.timelineTime).toBe(1_800_000_000_000);
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

  it("graphs Markdown notes by default and every other file with attachments shown", () => {
    const { notes, files } = makeVault({
      "Readme.md": "links [[Data]]",
      "Data.md": "",
      "Orphan.md": "no links here",
      "photo.png": "",
      "archive.zip": "",
      "doc.pdf": "",
      "script.ts": "",
    });
    // Obsidian's default: Markdown only. Other text documents count as attachments.
    expect(buildGraph(notes, files).nodes.map((n) => n.id).sort()).toEqual(["Data.md", "Orphan.md", "Readme.md"]);
    const { nodes } = buildGraph(notes, files, { showTags: false, existingOnly: false, showOrphans: true, showAttachments: true });
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId).sort()).toEqual(["Data.md", "Orphan.md", "Readme.md", "archive.zip", "doc.pdf", "photo.png", "script.ts"]);
    expect(byId["photo.png"].kind).toBe("attachment");
    // A text document keeps its note kind and parsed links when shown.
    expect(byId["script.ts"].kind).toBe("note");
    // Notes keep their kind/degree; an unlinked note is an isolated node in the
    // same force simulation.
    expect(byId["Readme.md"].kind).toBe("note");
    expect(byId["Orphan.md"].degree).toBe(0);
    expect(byId["Readme.md"].degree).toBe(1);
    expect(byId["Data.md"].degree).toBe(1);
  });

  it("drops a link to a hidden non-Markdown document instead of showing it as unresolved", () => {
    const { notes, files } = makeVault({ "A.md": "[[Notes.txt]] and [[Notes]]", "Notes.txt": "[[A]]" });
    expect(buildGraph(notes, files)).toMatchObject({ nodes: [{ id: "A.md", kind: "note", degree: 0 }], links: [] });
    const shown = buildGraph(notes, files, { showTags: false, existingOnly: false, showOrphans: true, showAttachments: true });
    expect(shown.nodes.map((n) => n.id).sort()).toEqual(["A.md", "Notes.txt"]);
    expect(shown.links).toHaveLength(2);
  });

  it("binary files stay out of the graph", () => {
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

  it("connects wiki links between text files", () => {
    const { notes, files } = makeVault({
      "Lorem Ipsum.txt": "[[Lorem Ipsum copy 1]]",
      "Lorem Ipsum copy 1.txt": "[[Lorem Ipsum.txt]]",
    });
    // Hidden by default, together with their links.
    expect(buildGraph(notes, files)).toMatchObject({ nodes: [], links: [] });
    const { nodes, links } = buildGraph(notes, files, { showTags: false, existingOnly: false, showOrphans: true, showAttachments: true });
    expect(nodes.map((node) => node.id).sort()).toEqual([
      "Lorem Ipsum copy 1.txt",
      "Lorem Ipsum.txt",
    ]);
    expect(links).toContainEqual({ source: "Lorem Ipsum.txt", target: "Lorem Ipsum copy 1.txt" });
    expect(links).toContainEqual({ source: "Lorem Ipsum copy 1.txt", target: "Lorem Ipsum.txt" });
    // GraphView derives node size from degree. Both files have one inbound and
    // one outbound atomic link, so they get the same larger linked-node size.
    expect(nodes.find((node) => node.id === "Lorem Ipsum.txt")?.degree).toBe(2);
    expect(nodes.find((node) => node.id === "Lorem Ipsum copy 1.txt")?.degree).toBe(2);
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
    // Obsidian shows unresolved links by default.
    expect(buildGraph(notes, files).nodes.some((n) => n.kind === "phantom")).toBe(true);
    // "Existing files only" hides them.
    expect(buildGraph(notes, files, { showTags: false, existingOnly: true, showOrphans: true, showAttachments: false }).nodes.some((n) => n.kind === "phantom")).toBe(false);

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

  it("links a heading or block reference to its note and never phantoms a same-note heading", () => {
    const { notes, files } = makeVault({
      "A.md": "[[B#Section]] [[sub/C.md#^block|alias]] [[#Local heading]] [[Ghost#Part]]",
      "B.md": "# Section",
      "sub/C.md": "text ^block",
    });
    const { nodes, links } = buildGraph(notes, files);
    expect(links).toContainEqual({ source: "A.md", target: "B.md" });
    expect(links).toContainEqual({ source: "A.md", target: "sub/C.md" });
    // Only the missing note is unresolved, named without its heading.
    expect(nodes.filter((n) => n.kind === "phantom").map((n) => n.title)).toEqual(["Ghost"]);
    expect(backlinksFor(notes, "B.md")).toEqual(["A.md"]);
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
    expect(byId["assets/page.html"].kind).toBe("note");
    expect(byId["assets/page.html"].degree).toBe(1);
    const endId = (e: unknown) => (typeof e === "string" ? e : (e as { id: string }).id);
    expect(links.some((l) => endId(l.source) === "Hero.md" && endId(l.target) === "doc.pdf")).toBe(true);
    // Unlinked attachments: same node kind, zero degree — they join the same
    // force simulation as everything else (Obsidian behavior); repulsion
    // halos them around the cluster, no special static layout.
    expect(byId["styles.css"].kind).toBe("note");
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

  it("resolves a leading-slash vault path by path, not by a same-named note elsewhere", () => {
    const { notes } = makeVault({ "a/Note.md": "x", "b/Note.md": "y" });
    expect(resolveTarget(notes, "/b/Note.md")).toBe("b/Note.md");
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

  it("gives an entry without reference metadata its references on the next refresh", () => {
    const { rawReferences: _references, ...legacy } = makeVault({ "A.md": "plain", "B.md": "" }).notes["A.md"];
    expect(refreshedNoteMeta(legacy, "plain")?.rawReferences).toEqual([]);
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

describe("Unicode normalization in link resolution", () => {
  const nfd = "Café"; // as macOS Finder may store it
  const nfc = "Café"; // as typed
  it("resolves an NFC link to an NFD-named note and back without renaming either", () => {
    const { notes, files } = makeVault({ [`${nfd}.md`]: "body", "Index.md": `[[${nfc}]] ![[${nfc} photo.png]]`, [`${nfd} photo.png`]: "" });
    expect(resolveTarget(notes, nfc)).toBe(`${nfd}.md`);
    expect(resolveAssetPath(files, `${nfc} photo.png`)).toBe(`/vault/${nfd} photo.png`);
    const { links } = buildGraph(notes, files);
    expect(links.some((link) => link.source === "Index.md" && link.target === `${nfd}.md`)).toBe(true);
    const back = makeVault({ [`${nfc}.md`]: "body" });
    expect(resolveTarget(back.notes, nfd)).toBe(`${nfc}.md`);
  });
});

describe("graph topology check", () => {
  const graph = (entries: Record<string, string>) => {
    const files = Object.keys(entries).map((rel) => vf(rel));
    return buildGraph(buildNotes(files, new Map(Object.entries(entries))), files).topology;
  };
  it("matches only the same node ids and link pairs, in any order", () => {
    const base = graph({ "A.md": "[[B]] [[C]]", "B.md": "[[A]]", "C.md": "" });
    expect(sameGraphTopology(null, base)).toBe(false);
    expect(sameGraphTopology(base, graph({ "C.md": "", "B.md": "[[A]]", "A.md": "[[C]] [[B]] text" }))).toBe(true);
    // Same counts, one link moved.
    expect(sameGraphTopology(base, graph({ "A.md": "[[B]] [[C]]", "B.md": "[[C]]", "C.md": "" }))).toBe(false);
    // Same link count, one node renamed.
    expect(sameGraphTopology(base, graph({ "A.md": "[[B]] [[D]]", "B.md": "[[A]]", "D.md": "" }))).toBe(false);
    expect(sameGraphTopology(base, graph({ "A.md": "[[B]] [[C]] [[Missing]]", "B.md": "[[A]]", "C.md": "" }))).toBe(false);
  });
});

describe("graph builder", () => {
  it("equals a full build after every kind of change, reusing unchanged notes", () => {
    const files = ["A.md", "B.md", "C.md", "D.txt", "img/p.png", "doc.pdf"].map((rel) => vf(rel, rel.endsWith(".md")));
    let notes = buildNotes(files, new Map([
      ["A.md", "[[B]] [[Ghost]] ![[p.png]] #x"], ["B.md", "[[A]] [[doc.pdf]] [[C#Part]]"], ["C.md", "[[Ghost]] #y [[D.txt]]"], ["D.txt", "plain"],
    ]));
    const steps: ((n: typeof notes) => typeof notes)[] = [
      (n) => ({ ...n, "A.md": { ...n["A.md"], rawLinks: [...n["A.md"].rawLinks, "C", "C", "Other ghost"] } }),
      (n) => ({ ...n, "C.md": { ...n["C.md"], tags: ["z", "y"], rawReferences: ["../doc.pdf"] } }),
      (n) => ({ ...n, "B.md": { ...n["B.md"], title: "Renamed" } }),
      (n) => ({ ...n, "B.md": { ...n["B.md"], aliases: ["Ghost"] } }),
      (n) => { const { ["D.txt"]: _removed, ...rest } = n; return rest; },
      (n) => ({ "C.md": n["C.md"], ...n }),
    ];
    for (const opts of [
      { showTags: true, existingOnly: false, showOrphans: true, showAttachments: true },
      { showTags: false, existingOnly: true, showOrphans: false, showAttachments: false },
      { showTags: true, existingOnly: false, showOrphans: false, showAttachments: false, showAllFiles: true },
    ]) {
      const build = createGraphBuilder();
      let current = notes;
      const strip = (g: ReturnType<typeof buildGraph>) => ({ nodes: g.nodes, links: g.links, ids: [...g.topology.ids], targets: [...g.topology.targets].map(([k, v]) => [k, [...v]]) });
      expect(strip(build(current, files, opts))).toEqual(strip(buildGraph(current, files, opts)));
      for (const step of steps) {
        current = step(current);
        expect(strip(build(current, files, opts))).toEqual(strip(buildGraph(current, files, opts)));
      }
      // A different file list or filter set rebuilds every note.
      expect(strip(build(current, files.slice(0, 5), opts))).toEqual(strip(buildGraph(current, files.slice(0, 5), opts)));
    }
    notes = {};
  });

  it("prepares a large build in deadline steps, then assembles exactly the full graph", () => {
    const files = Array.from({ length: 300 }, (_, i) => vf(`n${i}.md`));
    const notes = buildNotes(files, new Map(files.map((f, i) => [f.relPath, `[[n${(i * 7) % 300}]] [[Ghost ${i % 9}]] #t${i % 4}`])));
    const opts = { showTags: true, existingOnly: false, showOrphans: true, showAttachments: true };
    const build = createGraphBuilder();
    let steps = 0;
    // A deadline already past stops after every 64 notes.
    while (!build.prepare(notes, files, opts, -Infinity) && steps < 20) steps++;
    expect(steps).toBe(4);
    const strip = (g: ReturnType<typeof buildGraph>) => ({ nodes: g.nodes, links: g.links });
    expect(strip(build(notes, files, opts))).toEqual(strip(buildGraph(notes, files, opts)));
  });

  it("treats a reordered note list as a change", () => {
    const files = ["A.md", "B.md"].map((rel) => vf(rel));
    const notes = buildNotes(files, new Map([["A.md", "[[B]]"], ["B.md", ""]]));
    expect(sameGraphNotes(notes, { ...notes })).toBe(true);
    expect(sameGraphNotes(notes, { "B.md": notes["B.md"], "A.md": notes["A.md"] })).toBe(false);
    expect(sameGraphNotes(notes, { "A.md": notes["A.md"] })).toBe(false);
  });
});
