import { deflateSync } from "fflate";
import { parseTasks, type TaskItem } from "./taskParsing";

/** UTF-8 for normal text; exact UTF-16 preserves unfinished surrogate pairs. */
export interface IndexedDocument {
  bytes: Uint8Array;
  encoding: "utf8" | "utf16";
  chars: number;
  bloom: Uint8Array;
  tasks: TaskItem[];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function encodeDocument(text: string): IndexedDocument {
  let loneSurrogate = false;
  if (/[\uD800-\uDFFF]/.test(text)) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          loneSurrogate = true;
          break;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        loneSurrogate = true;
        break;
      }
    }
  }
  const encoding = loneSurrogate ? "utf16" : "utf8";
  const bytes = loneSurrogate
    ? new Uint8Array(text.length * 2)
    : new TextEncoder().encode(text);
  if (loneSurrogate) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      bytes[i * 2] = c;
      bytes[i * 2 + 1] = c >>> 8;
    }
  }
  const bloom = new Uint8Array(512);
  const lower = text.toLowerCase();
  for (let i = 0; i + 2 < lower.length; i++) {
    const bit = hash(lower.slice(i, i + 3)) % 4096;
    bloom[bit >>> 3] |= 1 << (bit & 7);
  }
  return {
    bytes: deflateSync(bytes, { level: 1 }),
    encoding,
    chars: text.length,
    bloom,
    tasks: JSON.parse(JSON.stringify(parseTasks("", "", text))) as TaskItem[],
  };
}
