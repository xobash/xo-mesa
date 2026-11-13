import { describe, expect, it, vi } from "vitest";
import type { NoteMeta, VaultFile } from "../types";
import * as graphModule from "./graph";
import { MINI_GRAPH_NODES, createMiniGraphBuilder, popoverVaults, rememberRecent, searchFiles } from "./trayPopover";

vi.mock("./graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph")>();
  return { ...actual, buildGraph: vi.fn(actual.buildGraph) };
});

const file = (relPath: string): VaultFile => ({
  relPath, path: `/vault/${relPath}`, name: relPath.replace(/^.*\//, "").replace(/\.md$/, ""), ext: "md", isMarkdown: true,
});
const note = (relPath: string, rawLinks: string[] = []): NoteMeta => ({ relPath, title: file(relPath).name, rawLinks, tags: [], aliases: [] });

describe("menu bar popover state", () => {
  it("ranks file-name matches and bounds the list", () => {
    const files = ["Inbox.md", "Projects/Index.md", "Daily/2026-11-02.md", ...Array.from({ length: 20 }, (_, i) => `Ideas/i${i}.md`)].map(file);
    expect(searchFiles(files, "  ")).toEqual([]);
    expect(searchFiles(files, "inbox")[0]).toEqual({ rel: "Inbox.md", title: "Inbox", folder: "" });
    expect(searchFiles(files, "index")[0].folder).toBe("Projects");
    expect(searchFiles(files, "i")).toHaveLength(6);
  });

  it("keeps linked best-connected files and always the open note", () => {
    const notes: Record<string, NoteMeta> = { "Hub.md": note("Hub.md") };
    const files = [file("Hub.md")];
    for (let i = 0; i < MINI_GRAPH_NODES + 50; i++) {
      const rel = `n${i}.md`;
      notes[rel] = note(rel, i < 40 ? ["Hub"] : []);
      files.push(file(rel));
    }
    const lonely = `n${MINI_GRAPH_NODES + 49}.md`;
    const graph = createMiniGraphBuilder()(notes, files, lonely, false);
    expect(graph.total).toBe(MINI_GRAPH_NODES + 51);
    // The hub, its 40 linked notes and the open note; unlinked files are left out.
    expect(graph.nodes).toHaveLength(42);
    expect(graph.nodes[0].id).toBe("Hub.md");
    expect(graph.nodes[graph.active].id).toBe(lonely);
    expect(graph.links).toHaveLength(40);
    for (const [s, t] of graph.links) expect(graph.nodes[s].id === "Hub.md" || graph.nodes[t].id === "Hub.md").toBe(true);
  });

  it("caps the drawn graph at MINI_GRAPH_NODES files", () => {
    const notes: Record<string, NoteMeta> = { "Hub.md": note("Hub.md") };
    const files = [file("Hub.md")];
    for (let i = 0; i < MINI_GRAPH_NODES + 100; i++) {
      notes[`n${i}.md`] = note(`n${i}.md`, ["Hub"]);
      files.push(file(`n${i}.md`));
    }
    const graph = createMiniGraphBuilder()(notes, files, null, false);
    expect(graph.nodes).toHaveLength(MINI_GRAPH_NODES);
    expect(graph.links).toHaveLength(MINI_GRAPH_NODES - 1);
    expect(graph.active).toBe(-1);
  });

  it("rebuilds and reranks the mini graph only when notes or files change", () => {
    const notes: Record<string, NoteMeta> = { "Hub.md": note("Hub.md") };
    const files = [file("Hub.md")];
    for (let i = 0; i < MINI_GRAPH_NODES + 20; i++) {
      notes[`n${i}.md`] = note(`n${i}.md`, i < MINI_GRAPH_NODES + 10 ? ["Hub", `n${i + 1}`] : []);
      files.push(file(`n${i}.md`));
    }
    const build = vi.mocked(graphModule.buildGraph);
    const cached = createMiniGraphBuilder();
    build.mockClear();
    const actives = [null, "Hub.md", "n5.md", `n${MINI_GRAPH_NODES + 5}.md`, `n${MINI_GRAPH_NODES + 15}.md`, "missing.md"];
    const results = actives.map((active) => cached(notes, files, active, true));
    expect(build).toHaveBeenCalledTimes(1);
    // Same nodes, order and links as an uncached build for every open note.
    actives.forEach((active, i) => expect(results[i]).toEqual(createMiniGraphBuilder()(notes, files, active, true)));
    build.mockClear();
    cached({ ...notes }, files, null, false);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("orders recents newest first and drops missing files", () => {
    const exists = (rel: string) => rel !== "gone.md";
    let recents = rememberRecent([], "a.md", exists);
    recents = rememberRecent(recents, "b.md", exists);
    recents = rememberRecent(recents, "a.md", exists);
    expect(recents).toEqual(["a.md", "b.md"]);
    expect(rememberRecent(["gone.md", "a.md"], null, exists)).toEqual(["a.md"]);
    expect(rememberRecent(Array.from({ length: 10 }, (_, i) => `${i}.md`), "x.md", exists)).toHaveLength(6);
  });

  it("marks the current vault", () => {
    expect(popoverVaults([{ id: "a", label: "A" }, { id: "b", label: "B" }], "b")).toEqual([
      { id: "a", label: "A", current: false },
      { id: "b", label: "B", current: true },
    ]);
  });
});
