/** A stable hue (0–359) derived from a string — for subtle color-coding of
 *  tags and file-type badges. Same input always yields the same hue. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
