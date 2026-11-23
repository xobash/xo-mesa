import { expect, it } from "vitest";
import type { GraphLink, GraphNode } from "../types";
import { NodePositions, linkIndex } from "./graphLinkGeometry";

const node = (id: string, x: number, y: number): GraphNode => ({ id, title: id, degree: 1, kind: "note", ext: "md", x, y, renderRadius: 4 });

it("indexes link ends once per link and node array", () => {
  const nodes = [node("a", 0, 0), node("b", 1, 1)];
  const links: GraphLink[] = [{ source: nodes[0], target: nodes[1] }, { source: nodes[1], target: node("c", 2, 2) }];
  const index = linkIndex(links, nodes);
  expect([...index.s, ...index.t]).toEqual([0, 1, 1, -1]);
  expect([index.sId, index.tId]).toEqual([["a", "b"], ["b", "c"]]);
  expect(index.nodeAt(nodes[1])).toBe(1);
  expect(linkIndex(links, nodes)).toBe(index);
  expect(linkIndex(links, [...nodes])).not.toBe(index);
});

it("reports moves of any node but the still one, and radius-only changes apart from placement", () => {
  const nodes = [node("a", 0, 0), node("b", 5, 5)];
  const positions = new NodePositions();
  expect(positions.load(nodes, null, () => 3)).toBe(true);
  expect(positions.load(nodes, null, () => 3)).toBe(false);
  nodes[0].x = 9; // the grabbed node moves alone
  expect(positions.load(nodes, "a", () => 3)).toBe(false);
  expect(positions.placesChanged).toBe(false);
  nodes[1].renderRadius = 6; // a zoom: drawn radius only
  expect(positions.load(nodes, "a", () => 3)).toBe(true);
  expect(positions.placesChanged).toBe(false);
  nodes[1].y = 7;
  expect(positions.load(nodes, "a", () => 3)).toBe(true);
  expect(positions.placesChanged).toBe(true);
  expect([positions.x[0], positions.y[1]]).toEqual([9, 7]);
});
