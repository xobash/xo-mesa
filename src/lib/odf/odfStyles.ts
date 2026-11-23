import { child, type XmlDoc, type XmlEl } from "../pptx/xmlTree";
import { isOdf, lengthToEmu, odfAttr } from "./odfNames";

// Style lookup for rendering: automatic styles in content.xml, then common
// and automatic styles in styles.xml, following parent styles a bounded
// number of steps. Only the properties Mesa draws are read.

export interface TextLook {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Font size in hundredths of a point. */
  size?: number;
  color?: string;
}

export interface StyleEntry {
  readonly el: XmlEl;
  readonly family: string;
  /** Lives in content.xml's automatic styles (Mesa may copy it). */
  readonly automaticInContent: boolean;
}

export interface OdfStyles {
  readonly byKey: ReadonlyMap<string, StyleEntry>;
  /** Every style name in either part, for picking unused names. */
  readonly names: ReadonlySet<string>;
  /** Graphic fill colour of a drawing style, if solid. */
  fill(name: string | null): string | null;
  /** Text look of a style (family `text` or `paragraph`), parents included. */
  look(family: string, name: string | null): TextLook;
}

const MAX_PARENT_STEPS = 16;

function collect(container: XmlEl | null, automaticInContent: boolean, into: Map<string, StyleEntry>, names: Set<string>): void {
  if (!container) return;
  for (const el of container.children) {
    if (!isOdf(el, "style", "style")) continue;
    const name = odfAttr(el, "style", "name");
    const family = odfAttr(el, "style", "family") ?? "";
    if (!name) continue;
    names.add(name);
    const key = `${family}:${name}`;
    if (!into.has(key)) into.set(key, { el, family, automaticInContent });
  }
}

function officeChild(doc: XmlDoc | null, local: string): XmlEl | null {
  return doc?.root.children.find((c) => isOdf(c, "office", local)) ?? null;
}

function textLookOf(el: XmlEl): TextLook {
  const props = el.children.find((c) => isOdf(c, "style", "text-properties"));
  if (!props) return {};
  const out: TextLook = {};
  const weight = odfAttr(props, "fo", "font-weight");
  if (weight) out.bold = weight === "bold" || Number(weight) >= 600;
  const style = odfAttr(props, "fo", "font-style");
  if (style) out.italic = style === "italic" || style === "oblique";
  const under = odfAttr(props, "style", "text-underline-style");
  if (under) out.underline = under !== "none";
  const strike = odfAttr(props, "style", "text-line-through-style");
  if (strike) out.strike = strike !== "none";
  const size = odfAttr(props, "fo", "font-size");
  const emu = size && !size.endsWith("%") ? lengthToEmu(size) : null;
  if (emu) out.size = Math.round(emu / 127);
  const color = odfAttr(props, "fo", "color");
  if (color && /^#[0-9a-f]{6}$/i.test(color)) out.color = color;
  return out;
}

/** Builds the style lookup for a package's content and styles parts. */
export function readOdfStyles(content: XmlDoc, styles: XmlDoc | null): OdfStyles {
  const byKey = new Map<string, StyleEntry>();
  const names = new Set<string>();
  collect(officeChild(content, "automatic-styles"), true, byKey, names);
  collect(officeChild(styles, "styles"), false, byKey, names);
  collect(officeChild(styles, "automatic-styles"), false, byKey, names);
  const cache = new Map<string, TextLook>();
  const look = (family: string, name: string | null): TextLook => {
    if (!name) return {};
    const key = `${family}:${name}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const chain: TextLook[] = [];
    let at: string | null = name;
    for (let step = 0; at && step < MAX_PARENT_STEPS; step++) {
      const entry = byKey.get(`${family}:${at}`);
      if (!entry) break;
      chain.push(textLookOf(entry.el));
      at = odfAttr(entry.el, "style", "parent-style-name");
    }
    const merged: TextLook = Object.assign({}, ...chain.reverse());
    cache.set(key, merged);
    return merged;
  };
  const fill = (name: string | null): string | null => {
    const entry = name ? byKey.get(`graphic:${name}`) ?? byKey.get(`presentation:${name}`) : undefined;
    const props = entry ? child(entry.el, "graphic-properties") : null;
    if (!props || odfAttr(props, "draw", "fill") !== "solid") return null;
    const color = odfAttr(props, "draw", "fill-color");
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  };
  return { byKey, names, look, fill };
}
