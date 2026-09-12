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

/** A usable sync listener/peer port. Port 0 is an OS-level ephemeral-bind
 *  sentinel, not an address another Mesa device can reconnect to. */
export function isValidSyncPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

/** Heal persisted/programmatic values before they reach discovery or Rust. */
export function normalizeSyncPort(value: unknown, fallback = 8787): number {
  if (isValidSyncPort(value)) return value;
  return isValidSyncPort(fallback) ? fallback : 8787;
}

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253 || /\s/.test(host)) return false;
  if (isIpv4(host)) return true;
  // Bracketed IPv6 literals are accepted by URL and unambiguous beside a port.
  if (host.startsWith("[") && host.endsWith("]")) {
    try {
      return new URL(`http://${host}`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  const labels = host.endsWith(".") ? host.slice(0, -1).split(".") : host.split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

/**
 * Turn whatever the user typed into a sync address (`host:port`).
 * Accepts a pairing code, a bare IP/hostname, `host:port`, or an http(s) URL.
 * Returns `null` for empty/garbage input.
 */
export function parsePeerInput(input: string, defaultPort = 8787): string | null {
  const t = input.trim();
  if (!t) return null;
  const safeDefaultPort = normalizeSyncPort(defaultPort);
  if (isPairingCode(t)) {
    const d = decodePairing(t, safeDefaultPort);
    return d && isValidSyncPort(d.port) ? `${d.host}:${d.port}` : null;
  }
  // URL form — keep as-is (sync layer will normalise the scheme), but reject
  // credentials, malformed hosts, and unusable explicit ports.
  if (/^https?:\/\//i.test(t)) {
    try {
      const url = new URL(t);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        !isValidHostname(url.hostname) ||
        (url.port && !isValidSyncPort(Number(url.port)))
      ) {
        return null;
      }
      return t.replace(/\/+$/, "");
    } catch {
      return null;
    }
  }
  // Host + port. IPv6 must stay bracketed so its colons are unambiguous.
  const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(t);
  if (withPort) {
    const [, host, portText] = withPort;
    const port = Number(portText);
    return isValidHostname(host) && isValidSyncPort(port)
      ? `${host}:${port}`
      : null;
  }
  if (!isValidHostname(t)) return null;
  return `${t}:${safeDefaultPort}`;
}
