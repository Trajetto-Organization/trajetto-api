import ExcelJS from "exceljs";

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

async function parseXlsx(buffer: Buffer): Promise<CellMatrix> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  // The first sheet, always. A workbook with the data on sheet three is a
  // workbook whose author will tell us; guessing which sheet is "the real one"
  // is how an import silently loads a lookup table.
  const sheet = workbook.worksheets[0];

  if (!sheet) return [];

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
    return parseCsv(buffer.toString("utf8"));
  }

  return parseXlsx(buffer);
}

export { parseCsv, readSpreadsheet };
export type { CellMatrix };
