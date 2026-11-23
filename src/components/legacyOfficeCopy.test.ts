import { beforeEach, expect, it, vi } from "vitest";
import { openOoxmlPackage } from "../lib/ooxml/ooxmlPackage";
import { openLegacyOffice } from "../lib/legacyOffice/legacyOffice";
import { buildDoc, buildXls, rkInt } from "../lib/legacyOffice/fixtures/legacyFixtures";
import type { VaultFile } from "../types";

const store = vi.hoisted(() => ({
  vaultPath: "/vault" as string | null,
  files: [] as { relPath: string }[],
  registerVaultFile: vi.fn(async () => undefined),
  openFile: vi.fn(async () => undefined),
}));
const io = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  save: vi.fn(async (args: { path: string; bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => {
    await args.validate?.(args.bytes);
  }),
}));
vi.mock("../store", () => ({ getStore: () => store }));
vi.mock("../lib/confirmAction", () => ({ confirmAction: io.confirm }));
vi.mock("../lib/documentBytesSave", () => ({ saveDocumentBytes: io.save }));
vi.mock("../lib/vaultPaths", () => ({ joinPath: (dir: string, name: string) => `${dir}/${name}` }));

import { editableCopyRelPath, makeEditableCopy } from "./legacyOfficeCopy";

const file: VaultFile = { path: "/vault/inbox/Old Plan.doc", relPath: "inbox/Old Plan.doc", name: "Old Plan", ext: "doc", isMarkdown: false } as VaultFile;
const word = openLegacyOffice(buildDoc([{ text: "Hello\r", compressed: true }]), "doc");

beforeEach(() => {
  store.vaultPath = "/vault";
  store.files = [{ relPath: "inbox/Old Plan.doc" }];
  vi.clearAllMocks();
  io.confirm.mockResolvedValue(true);
});

it("states what the copy loses and that the original is untouched, then writes a new file only", async () => {
  await expect(makeEditableCopy(file, word)).resolves.toBe("Created inbox/Old Plan.docx. The original is unchanged.");
  const [text, options] = io.confirm.mock.calls[0] as unknown as [string, { okLabel: string }];
  expect(text).toContain("inbox/Old Plan.docx");
  expect(text).toContain("Old Plan.doc itself is not changed");
  expect(text).toContain("loses all formatting");
  expect(options.okLabel).toBe("Create .docx copy");
  expect(io.save).toHaveBeenCalledTimes(1);
  const args = io.save.mock.calls[0][0];
  expect(args.path).toBe("/vault/inbox/Old Plan.docx");
  expect(args.expected).toBeNull();
  expect(openOoxmlPackage(args.bytes).kind).toBe("wordprocessing");
  expect(store.registerVaultFile).toHaveBeenCalledWith("inbox/Old Plan.docx");
  expect(store.openFile).toHaveBeenCalledWith("inbox/Old Plan.docx");
});

it("says formulas become values for workbooks", async () => {
  const excel = openLegacyOffice(buildXls([{ name: "A", cells: [{ kind: "rk", row: 0, col: 0, rk: rkInt(1) }] }]), "xls");
  await makeEditableCopy({ ...file, relPath: "Book.xls", name: "Book", ext: "xls" }, excel);
  expect((io.confirm.mock.calls[0] as unknown as [string])[0]).toContain("Formulas are not converted: each formula cell keeps only its last calculated value.");
  expect(io.save.mock.calls[0][0].path).toBe("/vault/Book.xlsx");
});

it("writes nothing when cancelled or when the vault changes during the prompt", async () => {
  io.confirm.mockResolvedValueOnce(false);
  await expect(makeEditableCopy(file, word)).resolves.toBeNull();
  io.confirm.mockImplementationOnce(async () => { store.vaultPath = "/other"; return true; });
  await expect(makeEditableCopy(file, word)).resolves.toBeNull();
  expect(io.save).not.toHaveBeenCalled();
});

it("never reuses an existing name and reports a refused write without opening anything", async () => {
  expect(editableCopyRelPath(["inbox/old plan.docx"], file, "docx")).toBe("inbox/Old Plan 1.docx");
  expect(editableCopyRelPath([], { relPath: "con.doc" }, "docx")).toBe("Converted copy.docx");
  io.save.mockRejectedValueOnce(new Error("A file with that name appeared before the copy was written; nothing was overwritten."));
  await expect(makeEditableCopy(file, word)).resolves.toMatch(/^Could not write the editable copy: A file with that name appeared/);
  expect(store.openFile).not.toHaveBeenCalled();
});
