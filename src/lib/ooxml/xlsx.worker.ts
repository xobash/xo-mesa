import { describeFailure, handleXlsxRequest, type XlsxWorkerRequest, type XlsxWorkerState } from "./xlsxWorkerProtocol";

// One worker per open spreadsheet view; it keeps the opened container so a
// save is written and verified off the interface thread.
const state: XlsxWorkerState = { container: null };

self.onmessage = (event: MessageEvent<{ id: number; request: XlsxWorkerRequest }>) => {
  const { id, request } = event.data;
  try {
    const reply = handleXlsxRequest(state, request);
    self.postMessage({ id, result: reply.result }, { transfer: reply.transfer });
  } catch (error) {
    self.postMessage({ id, failure: describeFailure(error) });
  }
};
