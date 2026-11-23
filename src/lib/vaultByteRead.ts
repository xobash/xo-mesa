import { invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import { RANGE_READ_MAX_BYTES, assertRange, memoryRangeReader, type RangeRead } from "./byteSource";
import { isDemo } from "./vaultFs";
import { demoRead } from "./vaultDemo";

/** The browser demo keeps the bounded in-memory path: at most 8 MiB. */
const DEMO_READ_BYTES = 8 * 1024 * 1024;
/** `u64` size + `u64` modification time in nanoseconds (vaultrange.rs). */
const RANGE_HEADER_BYTES = 16;

/** Prefix of the native refusal for an online-only cloud file
 *  (`vaultread.rs` `ONLINE_ONLY_READ`): bytes and range reads never download it. */
const ONLINE_ONLY_PREFIX = "online-only:";

/** True when a native bytes or range read refused an online-only cloud file. */
export function isOnlineOnlyReadError(reason: unknown): boolean {
  return String(reason instanceof Error ? reason.message : reason).startsWith(ONLINE_ONLY_PREFIX);
}

/** The user-facing text of a native read refusal, without the online-only marker. */
function readFailure(reason: unknown): Error {
  if (!isOnlineOnlyReadError(reason)) return reason instanceof Error ? reason : new Error(String(reason));
  const message = String(reason instanceof Error ? reason.message : reason);
  return new Error(message.slice(ONLINE_ONLY_PREFIX.length).trim());
}

/** Bytes from the start of a vault file through native `vault_read_bytes`, at
 *  most `maxBytes`; `requireComplete` refuses a longer file. The only renderer
 *  caller of that command, so an online-only refusal always reads plainly. */
export async function readVaultBytes(path: string, maxBytes: number, requireComplete: boolean): Promise<Uint8Array> {
  try {
    return new Uint8Array(await invoke<ArrayBuffer>("vault_read_bytes", { path, maxBytes, requireComplete }));
  } catch (reason) {
    throw readFailure(reason);
  }
}

/** Splits a `vault_read_range` body into its header and bytes. */
export function decodeRangeResponse(body: ArrayBuffer): RangeRead {
  if (body.byteLength < RANGE_HEADER_BYTES) throw new Error("The range read returned a damaged response.");
  const view = new DataView(body);
  const size = view.getBigUint64(0, true);
  const mtimeNs = view.getBigUint64(8, true);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This file is too large to address.");
  return { bytes: new Uint8Array(body, RANGE_HEADER_BYTES), size: Number(size), stamp: `${size}:${mtimeNs}` };
}

/**
 * At most 1 MiB of a vault file from `offset`, with the file's size and a
 * version stamp. Any offset works, so multi-GB files never load whole.
 */
export async function readVaultRange(file: VaultFile, offset: number, len: number): Promise<RangeRead> {
  assertRange(offset, len, RANGE_READ_MAX_BYTES);
  if (isDemo(file.path)) {
    const demo = new TextEncoder().encode(demoRead(file.relPath)).subarray(0, DEMO_READ_BYTES);
    return memoryRangeReader(demo, "demo")(offset, len);
  }
  let body: ArrayBuffer;
  try {
    body = await invoke<ArrayBuffer>("vault_read_range", { path: file.path, offset, len });
  } catch (reason) {
    throw readFailure(reason);
  }
  return decodeRangeResponse(body);
}
