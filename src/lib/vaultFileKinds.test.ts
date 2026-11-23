import { expect, it } from "vitest";
import { fileKind } from "./vaultFileKinds";
import { unsavedEditsLabel } from "./binaryEdits";

it("plays audio files in the audio player and keeps .ogg on the video element", () => {
  for (const ext of ["mp3", "wav", "m4a", "aac", "flac", "oga", "opus", "MP3"]) expect(fileKind(ext)).toBe("audio");
  for (const ext of ["mp4", "webm", "ogg", "ogv", "mov", "m4v"]) expect(fileKind(ext)).toBe("video");
  expect(fileKind("rtf")).toBe("rtf");
});

it("opens Excel Open XML workbooks in the spreadsheet view and leaves .xls and .ods to the file details view", () => {
  for (const ext of ["xlsx", "xlsm", "xltx", "xltm", "XLSX"]) expect(fileKind(ext)).toBe("spreadsheet");
  for (const ext of ["xls", "xlsb", "ods", "csv"]) expect(fileKind(ext)).not.toBe("spreadsheet");
});

it("names unsaved in-editor edits by file type", () => {
  expect(unsavedEditsLabel(["a.pdf"])).toBe("PDF edits");
  expect(unsavedEditsLabel(["Letter.rtf"])).toBe("RTF edits");
  expect(unsavedEditsLabel(["p/photo.JPG", "x.png"])).toBe("image edits");
  expect(unsavedEditsLabel(["Budget.xlsx"])).toBe("workbook edits");
  expect(unsavedEditsLabel(["a.pdf", "b.png"])).toBe("edits");
  // The extension comes from the file name, never a dotted folder.
  expect(unsavedEditsLabel(["v1.pdf/scan"])).toBe("edits");
  expect(unsavedEditsLabel(["Scans/.pdf"])).toBe("PDF edits");
});
