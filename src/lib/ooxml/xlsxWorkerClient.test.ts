import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPackage } from "./fixtures/ooxmlFixtures";
import { workbookParts } from "./fixtures/xlsxFixtures";
import { openXlsx } from "./xlsxOpen";
import { cellView, createDraft, setCellText } from "./xlsxDraft";
import { planXlsxSave } from "./xlsxSave";
import { createXlsxWorkerClient, MAX_WORKER_RESTARTS, WORKER_GONE_MESSAGE } from "./xlsxWorkerClient";
import { describeFailure, handleXlsxRequest, type XlsxWorkerRequest, type XlsxWorkerState } from "./xlsxWorkerProtocol";

/** A worker realm in this thread: each instance has its own workbook state, as a real worker does. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  received: string[] = [];
  private readonly state: XlsxWorkerState = { container: null };
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: { id: number; request: XlsxWorkerRequest }) {
    this.received.push(message.request.kind);
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        const reply = handleXlsxRequest(this.state, message.request);
        this.onmessage?.({ data: { id: message.id, result: reply.result } });
      } catch (error) {
        this.onmessage?.({ data: { id: message.id, failure: describeFailure(error) } });
      }
    });
  }
  terminate() { this.terminated = true; }
  crash() { this.onerror?.(); }
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

const SHEET = "xl/worksheets/sheet2.xml";

async function openWithPlan() {
  const client = createXlsxWorkerClient();
  const { session } = await client.open(buildPackage(workbookParts()));
  session.adoptIndex(SHEET, await client.index(session.workbook.partText(SHEET)));
  const plan = planXlsxSave(session, setCellText(session, createDraft(session), SHEET, 1, 0, "7"));
  return { client, plan };
}

describe("spreadsheet worker restart", () => {
  it("saves after the worker crashes by re-opening the workbook in a fresh worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { client, plan } = await openWithPlan();
    FakeWorker.instances[0].crash();
    const written = await client.write(plan);
    const reopened = openXlsx(written).session;
    expect(cellView(reopened, createDraft(reopened), SHEET, 1, 0).display).toBe("7");
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    // The replacement re-opened the last bytes before it wrote.
    expect(FakeWorker.instances[1].received).toEqual(["open", "write"]);
    client.dispose();
  });

  it("fails every request with a reopen message once restarts run out", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { client, plan } = await openWithPlan();
    for (let i = 0; i <= MAX_WORKER_RESTARTS; i++) {
      FakeWorker.instances.at(-1)!.crash();
      if (i < MAX_WORKER_RESTARTS) await client.index("<worksheet/>").catch(() => undefined);
    }
    await expect(client.write(plan)).rejects.toThrow(WORKER_GONE_MESSAGE);
    expect(FakeWorker.instances).toHaveLength(1 + MAX_WORKER_RESTARTS);
    client.dispose();
  });

  it("uses the in-thread path only when workers never existed", async () => {
    vi.stubGlobal("Worker", undefined);
    const { client, plan } = await openWithPlan();
    await expect(client.write(plan)).resolves.toBeInstanceOf(Uint8Array);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
