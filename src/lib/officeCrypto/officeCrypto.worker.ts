import { describeFailure, handleOfficeCryptoRequest, type OfficeCryptoRequest, type OfficeCryptoState } from "./protocol";

// One worker per open encrypted file: key derivation (up to millions of
// hashes) and AES run off the interface thread, and terminating the worker
// on close drops the password with it.
const state: OfficeCryptoState = { password: null };
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<{ id: number; request: OfficeCryptoRequest }>) => {
  const { id, request } = event.data;
  // Requests run one at a time, in order.
  queue = queue.then(async () => {
    try {
      const result = await handleOfficeCryptoRequest(state, request);
      self.postMessage({ id, result }, { transfer: result ? [result.buffer] : [] });
    } catch (error) {
      self.postMessage({ id, failure: describeFailure(error) });
    }
  });
};
