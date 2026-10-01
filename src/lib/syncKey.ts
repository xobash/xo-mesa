/** A device sync key is 32 random bytes, encoded as 64 hexadecimal characters. */
export function generateSyncKey(random: Pick<Crypto, "getRandomValues"> = crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validSyncKey(key: string): boolean {
  return key.length >= 32;
}
