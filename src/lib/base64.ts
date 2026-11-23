/** Standard base64 for bytes, built in bounded 32 KiB slices so large inputs
 *  never exceed the engine's argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
