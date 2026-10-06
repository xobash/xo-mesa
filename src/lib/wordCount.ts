/** Count words in one scan using the ECMAScript whitespace class, matching
 * text.trim().split(/\s+/) for non-empty text without allocating a word array. */

/**
 * Exactly the code points matched by the ECMAScript `\s` class: WhiteSpace
 * (tab, VT, FF, space, NBSP, ZWNBSP/BOM, plus Unicode Zs) and LineTerminator
 * (LF, CR, LS, PS). `String.prototype.trim` strips this same set, so a scan
 * built on it and a `trim().split(/\s+/)` agree on every input.
 */
export function isMarkdownWhitespace(code: number): boolean {
  switch (code) {
    case 0x09: // tab
    case 0x0a: // line feed
    case 0x0b: // vertical tab
    case 0x0c: // form feed
    case 0x0d: // carriage return
    case 0x20: // space
    case 0xa0: // no-break space
    case 0x1680: // ogham space mark
    case 0x2028: // line separator
    case 0x2029: // paragraph separator
    case 0x202f: // narrow no-break space
    case 0x205f: // medium mathematical space
    case 0x3000: // ideographic space
    case 0xfeff: // zero width no-break space (BOM)
      return true;
    default:
      // U+2000..U+200A — en/em quads, thin space, hair space, …
      return code >= 0x2000 && code <= 0x200a;
  }
}

/**
 * Number of whitespace-separated words in `text` — identical to
 * `text.trim() ? text.trim().split(/\s+/).length : 0`, with no allocation.
 */
export function countWords(text: string): number {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isMarkdownWhitespace(text.charCodeAt(i))) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}
