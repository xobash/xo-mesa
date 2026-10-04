/** A device sync key is 32 random bytes, encoded as 64 hexadecimal characters. */
export function generateSyncKey(random: Pick<Crypto, "getRandomValues"> = crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validSyncKey(key: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(key)) return false;
  const bytes = key.match(/../g)!;
  // Reject repeated, short-pattern and password-like inputs. Users paste a
  // generated device key; this check is not a claim to measure true entropy.
  return new Set(bytes).size >= 16 && new Set(key).size >= 12;
}
