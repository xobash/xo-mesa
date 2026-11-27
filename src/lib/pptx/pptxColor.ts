import { attr, child, intAttr, path, type XmlEl } from "./xmlTree";
import { bytesToHex } from "../hex";

// DrawingML colour resolution (ECMA-376 Part 1, 20.1.2.3): scheme colours via
// the master colour map and theme, plus the common modifiers. Anything Mesa
// does not model resolves to `null` so callers fall back visibly.

export interface ThemeInfo {
  /** Scheme slot (dk1, lt1, accent1 …) to `#rrggbb`. */
  readonly colors: ReadonlyMap<string, string>;
  /** Master colour map: bg1 → lt1, tx1 → dk1 … */
  readonly colorMap: ReadonlyMap<string, string>;
  readonly majorFont: string | null;
  readonly minorFont: string | null;
}

const HEX = /^[0-9a-fA-F]{6}$/;
const SCHEME_SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
const DEFAULT_COLOR_MAP: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
const PRESET: Record<string, string> = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00",
  gray: "808080", grey: "808080", orange: "ffa500", purple: "800080", silver: "c0c0c0", navy: "000080",
  darkGray: "a9a9a9", lightGray: "d3d3d3", darkBlue: "00008b", darkRed: "8b0000", darkGreen: "006400",
};

function baseHex(el: XmlEl): string | null {
  const v = attr(el, el.localName === "sysClr" ? "lastClr" : "val");
  return v && HEX.test(v) ? v.toLowerCase() : null;
}

export function readTheme(theme: XmlEl | null, master: XmlEl | null): ThemeInfo {
  const colors = new Map<string, string>();
  const scheme = path(theme, "themeElements", "clrScheme");
  for (const slot of SCHEME_SLOTS) {
    const holder = child(scheme, slot);
    const value = holder?.children[0];
    const hex = value && (value.localName === "srgbClr" || value.localName === "sysClr") ? baseHex(value) : null;
    if (hex) colors.set(slot, hex);
  }
  const colorMap = new Map(Object.entries(DEFAULT_COLOR_MAP));
  const clrMap = child(master, "clrMap");
  if (clrMap) for (const [name, value] of clrMap.attrs) colorMap.set(name, value);
  const fonts = path(theme, "themeElements", "fontScheme");
  return {
    colors, colorMap,
    majorFont: attr(path(fonts, "majorFont", "latin"), "typeface") || null,
    minorFont: attr(path(fonts, "minorFont", "latin"), "typeface") || null,
  };
}

function schemeHex(theme: ThemeInfo, name: string, placeholderColor: string | null): string | null {
  if (name === "phClr") return placeholderColor;
  const slot = theme.colorMap.get(name) ?? name;
  return theme.colors.get(slot) ?? null;
}

function toRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function applyModifiers(hex: string, mods: readonly XmlEl[]): string {
  let rgb = toRgb(hex);
  let alpha = 1;
  for (const mod of mods) {
    const v = intAttr(mod, "val", 100_000) / 100_000;
    if (mod.localName === "alpha") alpha = clamp01(v);
    else if (mod.localName === "lumMod" || mod.localName === "lumOff") {
      const hsl = rgbToHsl(rgb);
      hsl[2] = clamp01(mod.localName === "lumMod" ? hsl[2] * v : hsl[2] + v);
      rgb = hslToRgb(hsl);
    } else if (mod.localName === "tint") rgb = rgb.map((c) => c + (255 - c) * (1 - v)) as [number, number, number];
    else if (mod.localName === "shade") rgb = rgb.map((c) => c * v) as [number, number, number];
  }
  const [r, g, b] = rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))));
  return alpha >= 1 ? `#${bytesToHex([r, g, b])}` : `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/** Resolves the first colour child of `holder` (e.g. `a:solidFill`) to a CSS colour. */
export function resolveColor(holder: XmlEl | null, theme: ThemeInfo, placeholderColor: string | null = null): string | null {
  const el = holder?.children.find((c) => ["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr"].includes(c.localName));
  if (!el) return null;
  let hex: string | null = null;
  if (el.localName === "srgbClr" || el.localName === "sysClr") hex = baseHex(el);
  else if (el.localName === "schemeClr") hex = schemeHex(theme, attr(el, "val") ?? "", placeholderColor?.startsWith("#") ? placeholderColor.slice(1) : null);
  else if (el.localName === "prstClr") hex = PRESET[attr(el, "val") ?? ""] ?? null;
  else {
    const pct = (n: string) => Math.round(clamp01(intAttr(el, n, 0) / 100_000) * 255);
    hex = bytesToHex([pct("r"), pct("g"), pct("b")]);
  }
  return hex ? applyModifiers(hex, el.children) : null;
}

/** Text colour PowerPoint uses when no run, list or style names one: `tx1`
 *  through the master colour map. Without it a slide inherits the app's own
 *  text colour, which is light in dark themes. */
export function themeTextColor(theme: ThemeInfo): string | null {
  const hex = schemeHex(theme, "tx1", null);
  return hex ? applyModifiers(hex, []) : null;
}

/** Theme font for `+mj-lt` / `+mn-lt` references; other typefaces pass through. */
export function resolveTypeface(typeface: string | null, theme: ThemeInfo): string | null {
  if (!typeface) return null;
  if (typeface.startsWith("+mj")) return theme.majorFont;
  if (typeface.startsWith("+mn")) return theme.minorFont;
  return typeface;
}
