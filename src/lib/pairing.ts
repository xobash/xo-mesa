/**
 * LocalSend-style device pairing codes.
 *
 * A pairing code is a short, human-readable string that *encodes* an IPv4
 * address and, only when needed, a custom port. You can add a device by reading
 * out a code instead of typing a raw IP. It's a pure transform — no server, no
 * lookup table:
 *
 *   192.168.1.5:8787  <->  "#ABC-1234" style Crockford base32
 *
 * Default port codes are just IPv4 (32 bits) -> 7 base32 chars. Custom-port
 * codes keep the legacy IPv4 + port (48 bits) -> 10 chars shape. Decoding is
 * tolerant of spacing, lower case, and look-alike characters (I/L -> 1, O -> 0).
 */

// Crockford base32 — no I, L, O, U (avoids ambiguity when read aloud).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32(value: bigint, chars: number): string {
  let out = "";
  let n = value;
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function fromBase32(s: string): bigint | null {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = (n << 5n) | BigInt(v);
  }
  return n;
}

/** True if `host` is a dotted-quad IPv4 literal. */
export function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * Encode an IPv4 host + port into a grouped pairing code, or `null` if the
 * host isn't a plain IPv4 literal (hostnames/Tailscale names can't be packed).
 */
export function encodePairing(
  host: string,
  port: number,
  defaultPort = 8787
): string | null {
  if (!isIpv4(host)) return null;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  let n = 0n;
  for (const p of host.split(".")) n = (n << 8n) | BigInt(Number(p));
  if (port === defaultPort) {
    const raw = toBase32(n, 7); // IPv4 -> 7 readable chars
    return `#${raw.slice(0, 3)}-${raw.slice(3)}`;
  }
  n = (n << 16n) | BigInt(port);
  const raw = toBase32(n, 10); // 48 bits -> 10 chars
  return `#${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Strip formatting and normalise look-alike characters for decoding. */
function cleanCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** True if a string looks like a pairing code (7 or 10 base32 chars, no host punctuation). */
export function isPairingCode(input: string): boolean {
  const t = input.trim();
  if (/[.:/@]/.test(t)) return false; // looks like an address/URL
  const len = cleanCode(t).length;
  if (len === 7) return t.startsWith("#") || /[-\s]/.test(t);
  return len === 10;
}

/** Decode a pairing code back into `{ host, port }`, or `null` if invalid. */
export function decodePairing(
  code: string,
  defaultPort = 8787
): { host: string; port: number } | null {
  const clean = cleanCode(code);
  if (clean.length !== 7 && clean.length !== 10) return null;
  const n = fromBase32(clean);
  if (n === null) return null;
  const port = clean.length === 7 ? defaultPort : Number(n & 0xffffn);
  let rest = clean.length === 7 ? n : n >> 16n;
  const octets: number[] = [];
  for (let i = 0; i < 4; i++) {
    octets.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return { host: octets.join("."), port };
}

/**
 * Turn whatever the user typed into a sync address (`host:port`).
 * Accepts a pairing code, a bare IP/hostname, `host:port`, or an http(s) URL.
 * Returns `null` for empty/garbage input.
 */
export function parsePeerInput(input: string, defaultPort = 8787): string | null {
  const t = input.trim();
  if (!t) return null;
  if (isPairingCode(t)) {
    const d = decodePairing(t, defaultPort);
    return d ? `${d.host}:${d.port}` : null;
  }
  // URL form — keep as-is (sync layer will normalise the scheme).
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, "");
  // host or host:port — add the default port if none was given.
  if (/:\d+$/.test(t)) return t;
  return `${t}:${defaultPort}`;
}
