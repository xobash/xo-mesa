import { describe, expect, it } from "vitest";
import {
  delimiterForExt,
  detectDelimiter,
  insertColumn,
  insertRow,
  parseDelimitedRows,
  quoteField,
  removeColumn,
  removeRow,
  rowCells,
  scanDelimited,
  serializeTable,
  setCell,
} from "./delimitedTable";

describe("parseDelimitedRows", () => {
  it("parses simple CSV rows", () => {
    expect(parseDelimitedRows("a,b,c\n1,2,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("honours quoted fields with commas, newlines and escaped quotes", () => {
    const csv = `name,note\n"Doe, Jane","line1\nline2"\n"a ""quote""",x`;
    expect(parseDelimitedRows(csv, ",")).toEqual([
      ["name", "note"],
      ["Doe, Jane", "line1\nline2"],
      ['a "quote"', "x"],
    ]);
  });

  it("supports a tab delimiter", () => {
    expect(parseDelimitedRows("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("treats a quote inside an unquoted field as text (RFC 4180)", () => {
    expect(parseDelimitedRows('ab"c,d\n', ",")).toEqual([['ab"c', "d"]]);
  });
});

// Byte-exact round trips: an unchanged table writes back the exact source.
const ROUND_TRIP_SAMPLES = [
  "",
  "\n",
  "a,b\n1,2\n",
  "a,b\r\n1,2\r\n",
  "a,b\n1,2",
  "a,b\r\n1,2\n3,4\r5,6",
  '"quoted","with ""escape"""\n"multi\r\nline",x\r\n',
  "  spaced , cells ,\n,,\n\n\n",
  '"unterminated,quote\nkeeps,going',
  "﻿id,name\n1,Ann\n",
  "ragged\n1,2,3\n4,5\n",
];

describe("scanDelimited and serializeTable", () => {
  it.each(ROUND_TRIP_SAMPLES)("round-trips %j byte for byte", (source) => {
    expect(serializeTable(scanDelimited(source, ","))).toBe(source);
  });

  it("counts the widest row and picks the dominant break for new rows", () => {
    const table = scanDelimited("a\r\nb,c,d\r\ne\n", ",");
    expect(table.columns).toBe(3);
    expect(table.eol).toBe("\r\n");
    expect(table.rows).toHaveLength(3);
  });

  it("keeps unedited rows' exact bytes and re-quotes only the edited row", () => {
    const source = '"a" , b\r\n1,"two"\r\n"x,y",z\n';
    const table = setCell(scanDelimited(source, ","), 1, 0, 'one, "1"');
    expect(serializeTable(table)).toBe('"a" , b\r\n"one, ""1""",two\r\n"x,y",z\n');
  });

  it("returns the same table when a cell is set to its current value", () => {
    const table = scanDelimited("a,b\n", ",");
    expect(setCell(table, 0, 1, "b")).toBe(table);
    expect(setCell(table, 0, 5, "")).toBe(table);
  });

  it("pads a short row when a cell beyond its end is set", () => {
    const table = setCell(scanDelimited("a\nb,c\n", ","), 0, 2, "z");
    expect(serializeTable(table)).toBe("a,,z\nb,c\n");
  });
});

describe("row and column operations", () => {
  it("appends a row without adding a final break the file did not have", () => {
    const table = insertRow(scanDelimited("a,b\r\n1,2", ","), 2);
    expect(serializeTable(table)).toBe("a,b\r\n1,2\r\n,");
  });

  it("inserts a row in the middle with the dominant break", () => {
    const table = insertRow(scanDelimited("a,b\n1,2\n", ","), 1);
    expect(serializeTable(table)).toBe("a,b\n,\n1,2\n");
  });

  it("removing the last row keeps the final-break shape", () => {
    expect(serializeTable(removeRow(scanDelimited("a\nb\nc", ","), 2))).toBe("a\nb");
    expect(serializeTable(removeRow(scanDelimited("a\nb\nc\n", ","), 1))).toBe("a\nc\n");
  });

  it("inserts and removes a column, leaving rows too short to have it untouched", () => {
    const table = scanDelimited('a,"b"\n"only"\n', ",");
    expect(serializeTable(insertColumn(table, 1))).toBe("a,,b\nonly,\n");
    expect(serializeTable(removeColumn(table, 1))).toBe('a\n"only"\n');
    expect(removeColumn(table, 1).columns).toBe(1);
  });

  it("starts an empty file with one row", () => {
    const table = insertRow(scanDelimited("", ","), 0);
    expect(rowCells(table, 0)).toEqual([""]);
    expect(serializeTable(table)).toBe("\n");
  });
});

describe("detectDelimiter", () => {
  it("finds the delimiter that splits the leading rows consistently", () => {
    expect(detectDelimiter("name;city;note\r\nAnn;Wien;\"a, b\"\r\nBo;Graz;c\r\n", ",")).toBe(";");
    expect(detectDelimiter("a|b|c\n1|2|3\n", ",")).toBe("|");
    expect(detectDelimiter("a\tb\n1\t2\n", ",")).toBe("\t");
    expect(detectDelimiter("a,b;c\n1,2;3\n", ",")).toBe(",");
  });

  it("ignores delimiters inside quotes and falls back for one-column files", () => {
    expect(detectDelimiter('"x;y;z",1\n"p;q;r",2\n', ",")).toBe(",");
    expect(detectDelimiter("single\nvalues\n", ",")).toBe(",");
    expect(detectDelimiter("", "\t")).toBe("\t");
  });

  it("keeps a semicolon file's delimiter when a row is edited", () => {
    const source = "a;b\r\n1;2\r\n";
    const table = scanDelimited(source, detectDelimiter(source, ","));
    expect(serializeTable(setCell(table, 1, 0, "x;y"))).toBe('a;b\r\n"x;y";2\r\n');
  });
});

describe("helpers", () => {
  it("quotes only fields that need it", () => {
    expect(quoteField("plain", ",")).toBe("plain");
    expect(quoteField("a,b", ",")).toBe('"a,b"');
    expect(quoteField("a\tb", "\t")).toBe('"a\tb"');
    expect(quoteField('say "hi"', ",")).toBe('"say ""hi"""');
    expect(quoteField("two\nlines", ",")).toBe('"two\nlines"');
  });

  it("maps extensions to delimiters", () => {
    expect(delimiterForExt("CSV")).toBe(",");
    expect(delimiterForExt("tsv")).toBe("\t");
    expect(delimiterForExt("txt")).toBeNull();
  });

  it("scans a large file in one linear pass", () => {
    const row = '1,"two, quoted",3\r\n';
    const source = row.repeat(100_000);
    const table = scanDelimited(source, ",");
    expect(table.rows).toHaveLength(100_000);
    expect(rowCells(table, 99_999)).toEqual(["1", "two, quoted", "3"]);
    expect(serializeTable(setCell(table, 5, 0, "x"))).toBe(
      row.repeat(5) + 'x,"two, quoted",3\r\n' + row.repeat(99_994)
    );
  });
});
