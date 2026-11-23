/** Extension-level image edit support: small enough for the viewer bundle,
 *  so a refusal shows before the editor or any bytes load. */

export type EditableImageFormat = "png" | "jpeg" | "webp";

export function formatForExt(ext: string): EditableImageFormat | null {
  const e = ext.toLowerCase();
  if (e === "png") return "png";
  if (e === "jpg" || e === "jpeg") return "jpeg";
  if (e === "webp") return "webp";
  return null;
}

/** Why the editor refuses this file before any bytes are read, or null. */
export function imageEditRefusalForExt(ext: string): string | null {
  const e = ext.toLowerCase();
  if (e === "svg") return "SVG is a vector format. Mesa edits PNG, JPEG and WebP images; open the SVG source to change it.";
  if (e === "gif") return "GIF images can be animated and use a limited palette, so Mesa does not edit them.";
  if (formatForExt(e)) return null;
  return `Mesa edits PNG, JPEG and WebP images. ${e.toUpperCase() || "This"} images open read-only.`;
}
