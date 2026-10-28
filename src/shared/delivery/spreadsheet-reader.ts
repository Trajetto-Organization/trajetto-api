import ExcelJS from "exceljs";

import { AppError } from "@/shared/errors/AppError";

import {
  SpreadsheetTooLargeError,
  assertZipInflatesWithin,
} from "./zip-inflate-guard";

/**
 * How much an .xlsx may inflate to, all entries together. Twenty thousand
 * rows of a dozen columns is on the order of ten megabytes of XML; a zip that
 * expands past this is not a day of deliveries.
 */
const MAX_XLSX_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * More rows than any dispatcher loads in a day, by a wide margin — and a
 * ceiling on the work one request can ask of the process that also serves
 * everyone else's HTTP, sockets and queues.
 */
const MAX_SPREADSHEET_ROWS = 20_000;

/**
 * Cells the workbook may hold, every sheet together, counted before exceljs
 * loads it: the row ceiling times forty columns (the template has 26, plus
 * room for what an ERP export adds). A 20k × 50 workbook — 2.6 MB uploaded —
 * cost +329 MB of heap and a second of frozen event loop to load, only for
 * the row check to run after the price was paid.
 */
const MAX_SPREADSHEET_CELLS = MAX_SPREADSHEET_ROWS * 40;

function tooLarge(message: string, code: string): AppError {
  return new AppError(message, 413, code);
}

function assertRowCount(rows: number): void {
  if (rows > MAX_SPREADSHEET_ROWS) {
    throw tooLarge(
      `A planilha tem mais de ${MAX_SPREADSHEET_ROWS.toLocaleString("pt-BR")} linhas. Divida o arquivo e importe em partes.`,
      "SPREADSHEET_TOO_MANY_ROWS",
    );
  }
}

/**
 * Bytes to a matrix of cells. No decisions here — every decision about what a
 * row MEANS lives in `spreadsheet-parser`, which is pure and tested on its
 * own.
 *
 * Two formats because dispatchers have two: the `.xlsx` they keep, and the
 * `.csv` their customer's ERP exports.
 */
type CellMatrix = unknown[][];

/**
 * CSV as Excel actually writes it.
 *
 * Hand-rolled rather than pulled in, because the part that matters is small
 * and the part that is usually wrong is specific: a quoted field containing
 * the separator, a quoted field containing a NEWLINE, and the doubled quote
 * that escapes a quote. Brazilian addresses carry commas
 * ("Rua das Flores, 100, sala 2") and Excel quotes them, so a naive split on
 * commas shifts every column after the address by one — silently, into a
 * delivery that looks plausible and goes to the wrong street.
 *
 * The separator is detected rather than assumed: Excel in a pt-BR locale
 * writes semicolons, because the comma is the decimal separator.
 */
function parseCsv(text: string): CellMatrix {
  const withoutBom = text.replace(/^﻿/, "");

  // Count separators outside quotes on the header line — whichever wins is the
  // one the file uses.
  const firstLine = withoutBom.split(/\r?\n/, 1)[0] ?? "";

  let commas = 0;
  let semicolons = 0;
  let scanningQuoted = false;

  for (const character of firstLine) {
    if (character === '"') scanningQuoted = !scanningQuoted;
    else if (!scanningQuoted && character === ",") commas += 1;
    else if (!scanningQuoted && character === ";") semicolons += 1;
  }

  const separator = semicolons > commas ? ";" : ",";

  const rows: CellMatrix = [];

  let row: string[] = [];
  let field = "";

  let quoted = false;

  for (let index = 0; index < withoutBom.length; index += 1) {
    const character = withoutBom[index];

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (withoutBom[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }

      continue;
    }

    if (character === '"') {
      quoted = true;
      continue;
    }

    if (character === separator) {
      row.push(field.trim());
      field = "";
      continue;
    }

    if (character === "\n") {
      row.push(field.trim());
      rows.push(row);

      row = [];
      field = "";

      continue;
    }

    if (character === "\r") continue;

    field += character;
  }

  // Whatever the file ended on, if it ended on anything.
  if (field !== "" || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  return rows;
}

/**
 * The cheap half of reading an .xlsx: the inflated size and how many cells
 * and rows its sheets hold, from one pass over the zip. Refuses what is too
 * big to load; throws a plain Error for a file that is not a zip at all.
 */
function inspectXlsx(buffer: Buffer): void {
  let tally: { cells: number; rows: number };

  // On the INFLATED size: see zip-inflate-guard.
  try {
    tally = assertZipInflatesWithin(buffer, MAX_XLSX_INFLATED_BYTES);
  } catch (error) {
    if (error instanceof SpreadsheetTooLargeError) {
      throw tooLarge(
        "A planilha é grande demais para importar de uma vez. Divida o arquivo e importe em partes.",
        "SPREADSHEET_TOO_LARGE",
      );
    }

    throw error;
  }

  if (tally.cells > MAX_SPREADSHEET_CELLS) {
    throw tooLarge(
      "A planilha tem células demais para importar de uma vez. Remova as colunas que não são da importação ou divida o arquivo em partes.",
      "SPREADSHEET_TOO_LARGE",
    );
  }

  // Row elements, empty styled rows included, every sheet together: a coarse
  // bound (twice the ceiling) that stops an absurd file here; the exact
  // count of rows with values is checked after the load.
  if (tally.rows > MAX_SPREADSHEET_ROWS * 2) assertRowCount(tally.rows);
}

async function parseXlsx(buffer: Buffer): Promise<CellMatrix> {
  inspectXlsx(buffer);

  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  // The first sheet, always. A workbook with the data on sheet three is a
  // workbook whose author will tell us; guessing which sheet is "the real one"
  // is how an import silently loads a lookup table.
  const sheet = workbook.worksheets[0];

  if (!sheet) return [];

  assertRowCount(sheet.actualRowCount);

  const rows: CellMatrix = [];

  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];

    // exceljs indexes columns from 1 and puts a hole at 0.
    rows.push(values.slice(1));
  });

  return rows;
}

/**
 * Reads whatever the operator uploaded.
 *
 * The filename decides, and only the filename: sniffing the bytes would be
 * cleverer and would guess wrong on the day somebody uploads a CSV named
 * `.xlsx`, which is exactly the file that needs the clearest error.
 */
async function readSpreadsheet(
  filename: string,
  base64: string,
): Promise<CellMatrix> {
  const buffer = Buffer.from(base64, "base64");

  if (/\.csv$/i.test(filename)) {
    const rows = parseCsv(buffer.toString("utf8"));

    assertRowCount(rows.length);

    return rows;
  }

  return parseXlsx(buffer);
}

/**
 * What can be refused without reading the file: the cheap checks of
 * `readSpreadsheet`, run while the request is still open so a file that is
 * too big or not a spreadsheet answers 400/413 at once, before the upload is
 * queued. A CSV's lines are counted on its newlines (a quoted newline only
 * over-counts, never lets a bigger file through); an .xlsx is inspected as
 * a zip. Throws a plain Error for a file that is not one.
 */
function inspectSpreadsheet(filename: string, base64: string): void {
  const buffer = Buffer.from(base64, "base64");

  if (/\.csv$/i.test(filename)) {
    let lines = 1;
    let at = buffer.indexOf(0x0a);

    while (at !== -1 && at < buffer.length - 1) {
      lines += 1;
      at = buffer.indexOf(0x0a, at + 1);
    }

    // Quoted newlines inflate the count: decide on the real parse then.
    if (lines > MAX_SPREADSHEET_ROWS) {
      assertRowCount(parseCsv(buffer.toString("utf8")).length);
    }

    return;
  }

  inspectXlsx(buffer);
}

export {
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_ROWS,
  inspectSpreadsheet,
  parseCsv,
  readSpreadsheet,
};
export type { CellMatrix };
