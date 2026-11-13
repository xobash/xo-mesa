/** Lowercase hexadecimal, two digits per byte value, no separator. */
export function bytesToHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
