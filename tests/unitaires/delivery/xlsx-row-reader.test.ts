import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadWholeXlsx,
  readSpreadsheet,
  type CellMatrix,
} from "@/shared/delivery/spreadsheet-reader";
import {
  WholeLoadNeeded,
  readFirstSheetRows,
} from "@/shared/delivery/xlsx-row-reader";

import { handWrittenXlsx as handWritten } from "./support/xlsx-zip";

/**
 * The .xlsx read a row at a time gives the rows exceljs's whole load gives
 * (plano-escala F3-23b, review of wave 12).
 *
 * The whole load built ~350 bytes of objects per cell before the first row:
 * a 20k × 40 workbook within the reader's limits held 278 MB, past the
 * 256 MB thread ceiling of production and far past the 96 MB of the
 * staging api, so a file that imported before the thread now closed with a
 * 413. The row-at-a-time reader drives exceljs's own parsers and Row, and
 * keeps only the shared strings. These tests are its contract: on every
 * workbook here, byte for byte the same matrix as `xlsx.load` +
 * `eachRow({ includeEmpty: false })` — dates, rich text, formulas, inline
 * strings, sparse and styled cells, 1904 dates, the first sheet when it is
 * not the first part, a hidden one — and the shapes it cannot know before
 * the rows go out (merged cells, hyperlinks, rows out of order) go to the
 * whole load, with the whole load's answer. An exceljs bump that changes
 * the internals it drives fails here.
 */

async function rowByRow(buffer: Buffer): Promise<CellMatrix> {
  const rows: CellMatrix = [];

  await readFirstSheetRows(buffer, 64 * 1024 * 1024, (values) =>
    rows.push(values),
  );

  return rows;
}

async function whole(buffer: Buffer): Promise<CellMatrix> {
  const rows: CellMatrix = [];

  await loadWholeXlsx(buffer, {
    row: (values) => rows.push(values),
    restart: () => {
      throw new Error("the whole load never restarts");
    },
  });

  return rows;
}

async function written(book: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** Every kind of value a dispatcher's workbook carries. */
async function everyKindOfValue(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Entregas");

  sheet.addRow(["Destinatário", "Cidade", "Data", "Observação", "Peso"]);
  sheet.addRow([
    "Padaria Central",
    "São Paulo",
    new Date("2026-11-18T12:00:00.000Z"),
    {
      richText: [
        { text: "Rua das Flores, " },
        { font: { bold: true }, text: "100" },
      ],
    },
    12.5,
  ]);
  sheet.addRow([true, false, { error: "#REF!" }, "  com espaços  ", 0]);

  // Formulas with every kind of result, and a shared one.
  sheet.getCell("A4").value = { formula: "E2*2", result: 25 };
  sheet.getCell("B4").value = { formula: 'B2&"!"', result: "São Paulo!" };
  sheet.getCell("C4").value = {
    formula: "C2+1",
    result: new Date("2026-11-19T12:00:00.000Z"),
  };
  sheet.getCell("C4").numFmt = "dd/mm/yyyy";
  sheet.getCell("D4").value = { formula: "TRUE()", result: true };
  sheet.getCell("E4").value = { formula: "NA()", result: { error: "#N/A" } };
  sheet.getCell("A5").value = { formula: "A4+1", result: 26 };
  sheet.getCell("A6").value = { sharedFormula: "A5", result: 27 };
  sheet.getCell("A7").value = { formula: "A6+1" };

  // Sparse: a cell far to the right, a styled cell with no value, an empty
  // styled row, then a row after a gap.
  sheet.getCell("H8").value = "longe";
  sheet.getCell("C8").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFF00" },
  };
  sheet.getRow(9).font = { bold: true };
  sheet.getCell("A12").value = "depois do buraco";
  sheet.getCell("B12").value = 46_344;
  sheet.getCell("B12").numFmt = "dd/mm/yyyy";

  return written(book);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a workbook read row by row", () => {
  it("gives the whole load's rows, every kind of value", async () => {
    const buffer = await everyKindOfValue();
    const rows = await rowByRow(buffer);

    expect(rows).toStrictEqual(await whole(buffer));

    // What the parser downstream relies on, kept across the reader.
    expect(rows[1][2]).toBeInstanceOf(Date);
    expect(rows[1][3]).toMatchObject({
      richText: [{ text: "Rua das Flores, " }, { text: "100" }],
    });
    expect(rows[3][2]).toMatchObject({ result: expect.any(Date) });
    expect(rows[rows.length - 1][1]).toBeInstanceOf(Date);
  });

  it("reads the workbook's first sheet, not the first part, hidden or not", async () => {
    const book = new ExcelJS.Workbook();
    const lookup = book.addWorksheet("Tabela");
    const hidden = book.addWorksheet("Oculta", { state: "hidden" });
    const data = book.addWorksheet("Entregas");

    lookup.addRow(["tabela de apoio"]);
    hidden.addRow(["a aba oculta vem primeiro"]);
    data.addRow(["Destinatário"]);

    // workbook.xml lists Oculta, then Entregas, then Tabela; the parts are
    // still sheet1 (Tabela), sheet2 (Oculta) and sheet3 (Entregas). The
    // writer orders by orderNo, which its typings leave out.
    const place = (sheet: ExcelJS.Worksheet, orderNo: number) => {
      (sheet as unknown as { orderNo: number }).orderNo = orderNo;
    };

    place(hidden, 0);
    place(data, 1);
    place(lookup, 2);

    const buffer = await written(book);
    const rows = await rowByRow(buffer);

    expect(rows).toStrictEqual(await whole(buffer));
    expect(rows).toEqual([["a aba oculta vem primeiro"]]);
  });

  it("gives the whole load's rows for the XML other generators write", async () => {
    const sheet =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Destinatário</t></is></c>' +
      '<c r="B1" t="inlineStr"><is><r><t>Rua </t></r><r><rPr><b/></rPr><t>das Flores</t></r></is></c>' +
      '<c r="C1" t="str"><v>a &amp;amp; b</v></c><c r="D1" t="s"><v>0</v></c></row>' +
      // Cells after the first without `r`: the next column each.
      '<row r="2"><c r="A2"><v>1</v></c><c><v>42</v></c><c t="b"><v>1</v></c>' +
      '<c r="E2" s="1"><v>46344</v></c><c r="F2" t="e"><v>#N/A</v></c>' +
      '<c r="G2"><f>A2+1</f><v>2</v></c><c r="H2" t="str"><f>A1</f><v>Destinatário</v></c></row>' +
      '<row r="4" s="1" customFormat="1"/><row r="5"><c r="B5" s="1"/></row>' +
      '<row r="7" spans="1:3"><c r="C7"><v>-3.25</v></c></row>';

    for (const buffer of [
      handWritten({ sheet }),
      handWritten({ sheet, workbookPr: '<workbookPr date1904="1"/>' }),
      handWritten({ sheet, target: "/xl/worksheets/sheet1.xml" }),
    ]) {
      expect(await rowByRow(buffer)).toStrictEqual(await whole(buffer));
    }

    // Without the styles a date is the serial number; without the shared
    // strings a shared cell is its index: as the whole load gives them.
    const bare = handWritten({
      sheet:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>46344</v></c></row>',
      styles: false,
      sharedStrings: null,
    });

    expect(await rowByRow(bare)).toStrictEqual(await whole(bare));
  });

  it("never builds the workbook", async () => {
    const load = vi.spyOn(
      Object.getPrototypeOf(new ExcelJS.Workbook().xlsx),
      "load",
    );

    await expect(
      readSpreadsheet(
        "entregas.xlsx",
        (await everyKindOfValue()).toString("base64"),
      ),
    ).resolves.toHaveLength(9);

    expect(load).not.toHaveBeenCalled();
  });
});

describe("a workbook only the whole load can read", () => {
  /** What readSpreadsheet gives, and whether it took the whole load. */
  async function read(buffer: Buffer) {
    const load = vi.spyOn(
      Object.getPrototypeOf(new ExcelJS.Workbook().xlsx),
      "load",
    );
    const rows = await readSpreadsheet(
      "entregas.xlsx",
      buffer.toString("base64"),
    );

    return { rows, wholeLoad: load.mock.calls.length > 0 };
  }

  it("goes there for merged cells, whose slaves repeat the master", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Entregas");

    sheet.addRow(["Cliente", "Pedido"]);
    sheet.addRow(["Padaria Central", "P1"]);
    sheet.addRow([null, "P2"]);
    sheet.mergeCells("A2:A3");

    const buffer = await written(book);

    await expect(rowByRow(buffer)).rejects.toBeInstanceOf(WholeLoadNeeded);

    const { rows, wholeLoad } = await read(buffer);

    expect(wholeLoad).toBe(true);
    expect(rows).toStrictEqual(await whole(buffer));
    expect(rows[2][0]).toBe("Padaria Central");
  });

  it("goes there for hyperlinks, which turn a value into text and link", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Entregas");

    sheet.addRow(["Rastreio"]);
    sheet.getCell("A2").value = {
      text: "acompanhe",
      hyperlink: "https://example.com/rastreio",
    };

    const buffer = await written(book);

    await expect(rowByRow(buffer)).rejects.toBeInstanceOf(WholeLoadNeeded);

    const { rows, wholeLoad } = await read(buffer);

    expect(wholeLoad).toBe(true);
    expect(rows).toStrictEqual(await whole(buffer));
  });

  it("goes there for rows out of order, dropping the rows it had handed", async () => {
    const buffer = handWritten({
      sheet:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>um</t></is></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>três</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>dois</t></is></c></row>',
    });

    await expect(rowByRow(buffer)).rejects.toBeInstanceOf(WholeLoadNeeded);

    const { rows, wholeLoad } = await read(buffer);

    expect(wholeLoad).toBe(true);
    expect(rows).toEqual([["um"], ["dois"], ["três"]]);
  });

  it("goes there for a row with no number, and fails as the whole load fails", async () => {
    const buffer = handWritten({
      sheet:
        '<row><c r="A1" t="inlineStr"><is><t>sem número</t></is></c></row>',
    });

    await expect(rowByRow(buffer)).rejects.toBeInstanceOf(WholeLoadNeeded);

    const expected = await whole(buffer).catch((error: Error) => error.message);
    const actual = await readSpreadsheet(
      "entregas.xlsx",
      buffer.toString("base64"),
    ).catch((error: Error) => error.message);

    expect(actual).toBe(expected);
  });
});
