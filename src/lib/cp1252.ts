// Windows-1252 decoding, shared by the RTF readers and legacy Word text.

/** Windows-1252 characters for bytes 0x80-0x9F; undefined bytes keep their code. */
const CP1252_80_9F = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f" +
  "\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** The character for one Windows-1252 byte (0x00-0xFF). */
export function cp1252Char(code: number): string {
  return code >= 0x80 && code <= 0x9f ? CP1252_80_9F[code - 0x80] : String.fromCharCode(code);
}
