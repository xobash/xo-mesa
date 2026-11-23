import { expect, it, vi } from "vitest";
import type { GraphLink } from "../types";
import { buildNeighbors } from "../lib/graph";
import { LazyLinkIndex, linkAdjacency, neighborsOf } from "./graphLinkIndex";

it("builds only on the first read after the links change, and binds an assigned value to the shown links", () => {
  let links: GraphLink[] = [{ source: "a", target: "b" }];
  const build = vi.fn(linkAdjacency);
  const index = new LazyLinkIndex(() => links, build, new Map<string, number[]>());
  expect(build).not.toHaveBeenCalled();
  expect(index.current.get("a")).toEqual([0]);
  expect(index.current.get("b")).toEqual([0]);
  expect(build).toHaveBeenCalledTimes(1);
  links = [...links, { source: "b", target: "c" }];
  expect(index.current.get("b")).toEqual([0, 1]);
  expect(build).toHaveBeenCalledTimes(2);
  const given = new Map([["z", [9]]]);
  index.current = given;
  expect(index.current).toBe(given);
  expect(build).toHaveBeenCalledTimes(2);
});

it("finds the same neighbours for the asked nodes as a full neighbour map", () => {
  const links: GraphLink[] = [{ source: "a", target: "b" }, { source: "c", target: "a" }, { source: "b", target: "c" }, { source: "d", target: "b" }];
  const full = buildNeighbors(links);
  const some = neighborsOf(new Set(["a", "d"]), links);
  expect([...some.keys()].sort()).toEqual(["a", "d"]);
  expect(some.get("a")).toEqual(full.get("a"));
  expect(some.get("d")).toEqual(full.get("d"));
});
