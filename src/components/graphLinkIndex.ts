import type { GraphLink } from "../types";

/**
 * A ref-shaped lookup derived from the current link array: built on the first
 * read after the links change, not on every rebuild. Nothing reads it until a
 * hover, an activity card or a replay needs it, so a data change skips the
 * work (10.5 ms for adjacency and 14.5 ms for neighbours at 92,775 links,
 * Measured). Assigning `current` binds a value built elsewhere to the links
 * shown at that moment.
 */
export class LazyLinkIndex<T> {
  private builtFor: readonly GraphLink[] | null = null;
  private value: T;

  constructor(
    private readonly links: () => readonly GraphLink[],
    private readonly build: (links: readonly GraphLink[]) => T,
    empty: T
  ) {
    this.value = empty;
  }

  get current(): T {
    const links = this.links();
    if (links !== this.builtFor) {
      this.value = this.build(links);
      this.builtFor = links;
    }
    return this.value;
  }

  set current(value: T) {
    this.value = value;
    this.builtFor = this.links();
  }
}

const endpoint = (end: GraphLink["source"]): string => (typeof end === "string" ? end : end.id);

/** For each node id, the indices of the links that touch it. */
export function linkAdjacency(links: readonly GraphLink[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < links.length; i++) {
    for (const id of [endpoint(links[i].source), endpoint(links[i].target)]) {
      let list = out.get(id);
      if (!list) out.set(id, (list = []));
      list.push(i);
    }
  }
  return out;
}

/** Neighbours of only the `ids` given, from one pass over the links. */
export function neighborsOf(ids: ReadonlySet<string>, links: readonly GraphLink[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    if (!ids.has(a)) return;
    let set = out.get(a);
    if (!set) out.set(a, (set = new Set()));
    set.add(b);
  };
  for (const link of links) {
    const s = endpoint(link.source), t = endpoint(link.target);
    join(s, t);
    join(t, s);
  }
  return out;
}
