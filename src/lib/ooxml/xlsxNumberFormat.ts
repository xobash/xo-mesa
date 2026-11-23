// Display of SpreadsheetML numbers through their number format (ECMA-376
// Part 1, 18.8.30 built-in formats and 18.8.31 format codes). Mesa shows a
// close, locale-neutral rendering: dates as ISO 8601, numbers with the
// format's decimals, grouping, percent, exponent and currency literals.
// Fractions, conditions and padding are approximated, never evaluated.

export const BUILTIN_NUMBER_FORMATS: Readonly<Record<number, string>> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};

export interface CompiledNumberFormat {
  readonly kind: "general" | "number" | "percent" | "scientific" | "date" | "text";
  readonly decimals: number;
  readonly grouping: boolean;
  readonly prefix: string;
  readonly suffix: string;
  readonly parenthesesForNegative: boolean;
  readonly hasDate: boolean;
  readonly hasTime: boolean;
  readonly hasSeconds: boolean;
  readonly exponentDigits: number;
}

const GENERAL: CompiledNumberFormat = {
  kind: "general", decimals: 0, grouping: false, prefix: "", suffix: "", parenthesesForNegative: false,
  hasDate: false, hasTime: false, hasSeconds: false, exponentDigits: 0,
};

/** Splits on `;` outside quotes and brackets. */
function sections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\\" && !quoted && i + 1 < code.length) { current += ch + code[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (ch === ";" && !quoted && !bracket) { out.push(current); current = ""; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

interface Split { pattern: string; literals: Array<{ at: number; text: string }> }

/** Separates literal text (quoted, escaped, currency tags) from pattern characters. */
function splitLiterals(section: string): Split {
  let pattern = "";
  const literals: Array<{ at: number; text: string }> = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      const close = section.indexOf('"', i + 1);
      const end = close < 0 ? section.length : close;
      literals.push({ at: pattern.length, text: section.slice(i + 1, end) });
      i = end;
    } else if (ch === "\\" && i + 1 < section.length) {
      literals.push({ at: pattern.length, text: section[++i] });
    } else if (ch === "[") {
      const close = section.indexOf("]", i + 1);
      const end = close < 0 ? section.length : close;
      const tag = section.slice(i + 1, end);
      const currency = /^\$([^-\]]*)/.exec(tag);
      if (currency?.[1]) literals.push({ at: pattern.length, text: currency[1] });
      else if (/^h+$|^m+$|^s+$/i.test(tag)) pattern += tag; // elapsed time
      i = end;
    } else if (ch === "_" || ch === "*") {
      i++; // padding and fill characters
    } else if (ch === "%") {
      pattern += ch;
      literals.push({ at: pattern.length, text: ch });
    } else if (/[$\-+/():!^&'~{}<>= ]/.test(ch)) {
      literals.push({ at: pattern.length, text: ch });
    } else {
      pattern += ch;
    }
  }
  return { pattern, literals };
}

export function compileNumberFormat(code: string): CompiledNumberFormat {
  if (!code || /^general$/i.test(code.trim())) return GENERAL;
  const [first, second] = sections(code);
  const { pattern, literals } = splitLiterals(first);
  if (pattern === "@" || (pattern.includes("@") && !/[0#?]/.test(pattern))) return { ...GENERAL, kind: "text" };
  if (/general/i.test(pattern)) return GENERAL;
  const hasDate = /[yd]/i.test(pattern) || (/m/i.test(pattern) && !/[hs]/i.test(pattern) && !/[0#?]/.test(pattern));
  const hasTime = /[hs]/i.test(pattern);
  if (hasDate || hasTime) return { ...GENERAL, kind: "date", hasDate, hasTime, hasSeconds: /s/i.test(pattern) };
  const firstDigit = pattern.search(/[0#?]/);
  if (firstDigit < 0) return { ...GENERAL, prefix: literals.map((l) => l.text).join("") };
  const lastDigit = Math.max(pattern.lastIndexOf("0"), pattern.lastIndexOf("#"), pattern.lastIndexOf("?"));
  const decimalPoint = pattern.indexOf(".");
  const exponent = /E[+-]/i.test(first) && /E/i.test(pattern);
  const decimalEnd = exponent ? pattern.search(/E/i) : lastDigit + 1;
  const decimals = decimalPoint >= 0 && decimalPoint < decimalEnd ? (pattern.slice(decimalPoint + 1, decimalEnd).match(/[0#?]/g) ?? []).length : 0;
  return {
    kind: exponent ? "scientific" : pattern.includes("%") ? "percent" : "number",
    decimals,
    grouping: pattern.slice(firstDigit, decimalPoint >= 0 ? decimalPoint : lastDigit + 1).includes(","),
    prefix: literals.filter((l) => l.at <= firstDigit).map((l) => l.text).join("").replace(/^[-+]$/, ""),
    suffix: literals.filter((l) => l.at > lastDigit).map((l) => l.text).join(""),
    parenthesesForNegative: second !== undefined && splitLiterals(second).literals.some((l) => l.text === "("),
    hasDate: false, hasTime: false, hasSeconds: false,
    exponentDigits: exponent ? Math.max(1, (pattern.slice(decimalEnd).match(/0/g) ?? []).length) : 0,
  };
}

function group(integer: string): string {
  let out = "";
  for (let i = 0; i < integer.length; i++) {
    if (i > 0 && (integer.length - i) % 3 === 0) out += ",";
    out += integer[i];
  }
  return out;
}

/** Excel's General: up to 11 significant characters, exponent for very large or small values. */
export function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) {
    const [mantissa, exponent] = value.toExponential(5).split("e");
    const digits = exponent.replace(/^[+-]/, "").padStart(2, "0");
    return `${mantissa.replace(/\.?0+$/, "")}E${exponent[0] === "-" ? "-" : "+"}${digits}`;
  }
  return String(Number(value.toPrecision(10)));
}

const DAY_MS = 86_400_000;

/** Converts a serial date to UTC milliseconds. The 1900 system keeps Excel's phantom 1900-02-29 (serial 60). */
export function serialToUtcMs(serial: number, date1904: boolean): number | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  if (date1904) return Date.UTC(1904, 0, 1) + serial * DAY_MS;
  const days = serial < 60 ? serial + 1 : serial;
  return Date.UTC(1899, 11, 30) + days * DAY_MS;
}

/** UTC calendar date to a serial date, the inverse of `serialToUtcMs` outside the phantom day. */
export function utcMsToSerial(ms: number, date1904: boolean): number {
  if (date1904) return (ms - Date.UTC(1904, 0, 1)) / DAY_MS;
  const days = (ms - Date.UTC(1899, 11, 30)) / DAY_MS;
  return days < 61 ? days - 1 : days;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatDate(serial: number, format: CompiledNumberFormat, date1904: boolean): string {
  if (!date1904 && Math.floor(serial) === 60 && format.hasDate) return "1900-02-29";
  const ms = serialToUtcMs(serial, date1904);
  if (ms === null) return formatGeneral(serial);
  const d = new Date(Math.round(ms / 1000) * 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${format.hasSeconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  if (format.hasDate && format.hasTime) return `${date} ${time}`;
  return format.hasDate ? date : time;
}

/** Display text of a numeric cell value under `format`. */
export function formatNumber(value: number, format: CompiledNumberFormat, date1904 = false): string {
  if (format.kind === "general" || format.kind === "text") return format.prefix + formatGeneral(value);
  if (format.kind === "date") return formatDate(value, format, date1904);
  if (format.kind === "scientific") {
    const [mantissa, exp] = value.toExponential(format.decimals).split("e");
    return `${mantissa}E${exp[0] === "-" ? "-" : "+"}${exp.replace(/^[+-]/, "").padStart(format.exponentDigits, "0")}`;
  }
  const scaled = format.kind === "percent" ? value * 100 : value;
  const fixed = Math.abs(scaled).toFixed(format.decimals);
  const [integer, fraction] = fixed.split(".");
  const body = (format.grouping ? group(integer) : integer) + (fraction ? `.${fraction}` : "");
  const signed = `${format.prefix}${body}${format.suffix}`;
  if (scaled >= 0 || Number(fixed) === 0) return signed;
  return format.parenthesesForNegative ? `(${signed})` : `-${signed}`;
}
