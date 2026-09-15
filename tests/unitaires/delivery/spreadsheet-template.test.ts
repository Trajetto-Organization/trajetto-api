import { describe, expect, it } from "vitest";

import ExcelJS from "exceljs";

import {
  DATA_SHEET,
  EXAMPLE_SHEET,
  buildTemplateWorkbook,
} from "@/shared/delivery/spreadsheet-template-file";

import { readSpreadsheet } from "@/shared/delivery/spreadsheet-reader";
import { parseDeliverySpreadsheet } from "@/shared/delivery/spreadsheet-parser";

import {
  HEADER_LOOKUP,
  REQUIRED_KEYS,
  TEMPLATE_COLUMNS,
  normalizeHeader,
} from "@/shared/delivery/spreadsheet-template";

/**
 * The model we publish, read back by the importer that has to accept it.
 *
 * This is the one test in the import feature that could not be written against
 * a fixture: the whole risk is that the file we generate and the file we parse
 * drift apart, and a hand-written fixture of "what the template looks like"
 * drifts with neither. So a real workbook is produced, serialised to xlsx
 * bytes, and fed through `readSpreadsheet` — the same path an upload takes.
 *
 * The failure it exists to prevent is specific and was real: the template
 * marks required columns "Destinatário *", and until `normalizeHeader` learnt
 * to drop an asterisk, a dispatcher who filled in our own model got every row
 * refused for missing the columns they had in fact filled in.
 */
async function generated() {
  const file = await buildTemplateWorkbook();

  return { file, base64: file.toString("base64") };
}

async function sheetsOf(file: Buffer) {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(file as unknown as ArrayBuffer);

  return workbook.worksheets;
}

describe("the model we publish", () => {
  it("is a real xlsx the importer can open", async () => {
    const { base64 } = await generated();

    const matrix = await readSpreadsheet("modelo.xlsx", base64);

    expect(matrix.length).toBeGreaterThan(0);
  });

  it("puts every column it publishes in the header row", async () => {
    const { file } = await generated();

    const [data] = await sheetsOf(file);

    const header = (data.getRow(1).values as unknown[]).slice(1);

    expect(header).toHaveLength(TEMPLATE_COLUMNS.length);
  });

  it("marks the required columns, and the parser still recognises them", async () => {
    // The asterisk and the round trip, as one assertion: whatever decoration
    // the model puts on a header has to survive `normalizeHeader`.
    const { file } = await generated();

    const [data] = await sheetsOf(file);

    const header = (data.getRow(1).values as unknown[]).slice(1);

    const marked = header.filter(
      (value) => typeof value === "string" && value.includes("*"),
    );

    expect(marked).toHaveLength(REQUIRED_KEYS.length);

    for (const value of header) {
      expect(HEADER_LOOKUP.get(normalizeHeader(String(value)))).toBeDefined();
    }
  });

  it("reports no unknown header when its own file is uploaded back", async () => {
    const { base64 } = await generated();

    const matrix = await readSpreadsheet("modelo.xlsx", base64);
    const result = parseDeliverySpreadsheet(matrix);

    expect(result.unknownHeaders).toEqual([]);
  });

  it("accepts a row filled in under its own header", async () => {
    const { file } = await generated();

    const [data] = await sheetsOf(file);

    const header = (data.getRow(1).values as unknown[]).slice(1);

    const result = parseDeliverySpreadsheet([
      header,
      [
        "entrega",
        "Padaria Central Ltda",
        "11222333000181",
        "11999999999",
        "",
        "01001000",
        "São Paulo",
        "SP",
        "Praça da Sé",
        "100",
      ],
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].recipient_name).toBe("Padaria Central Ltda");
  });
});

describe("the worked example", () => {
  it("lives on a second sheet, which the importer never reads", async () => {
    // An example row under the header is a delivery to Praça da Sé in
    // somebody's production data, the first time a dispatcher fills the model
    // in without deleting it.
    const { file, base64 } = await generated();

    const sheets = await sheetsOf(file);

    expect(sheets.map((sheet) => sheet.name)).toEqual([
      DATA_SHEET,
      EXAMPLE_SHEET,
    ]);

    const matrix = await readSpreadsheet("modelo.xlsx", base64);
    const result = parseDeliverySpreadsheet(matrix);

    expect(result.rows).toEqual([]);
  });

  it("is actually filled in, so it is worth being there", async () => {
    const { file } = await generated();

    const sheets = await sheetsOf(file);
    const example = sheets[1];

    const row = (example.getRow(2).values as unknown[]).slice(1);

    expect(row.filter(Boolean).length).toBeGreaterThan(5);
  });
});

describe("uploading the model untouched", () => {
  it("says the file is blank rather than reporting a silent zero", async () => {
    // "0 importadas, 0 duplicadas, 0 com erro" reads like the importer broke.
    const { base64 } = await generated();

    const matrix = await readSpreadsheet("modelo.xlsx", base64);
    const result = parseDeliverySpreadsheet(matrix);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("nenhuma linha preenchida");
  });
});
