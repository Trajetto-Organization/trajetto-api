import ExcelJS from "exceljs";

import { TEMPLATE_COLUMNS } from "./spreadsheet-template";

const TEMPLATE_FILENAME = "modelo-importacao-trajetto.xlsx";

const TEMPLATE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The sheet the importer reads, and the one it must never read. */
const DATA_SHEET = "Entregas";
const EXAMPLE_SHEET = "Exemplo";

function headerFor(column: (typeof TEMPLATE_COLUMNS)[number]): string {
  // The asterisk is why `normalizeHeader` strips one: a file filled in from
  // this model comes back with them in its header row, and the four columns
  // that matter most would arrive unrecognised.
  return column.required ? `${column.header} *` : column.header;
}

function layOutColumns(sheet: ExcelJS.Worksheet): void {
  sheet.columns = TEMPLATE_COLUMNS.map((column) => ({
    header: headerFor(column),
    key: column.key,
    width: Math.max(column.header.length + 4, 18),
  }));

  const header = sheet.getRow(1);

  header.font = { bold: true };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEFEF" },
  };

  TEMPLATE_COLUMNS.forEach((column, position) => {
    const cell = header.getCell(position + 1);

    if (column.required) {
      cell.font = { bold: true, color: { argb: "FFB00020" } };
    }

    if (column.help) {
      cell.note = column.help;
    }
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * The file we ask people to fill in.
 *
 * Generated rather than kept as a static asset, so it cannot drift from the
 * parser: both read `TEMPLATE_COLUMNS`, and a column added to one appears in
 * the other on the next download. A published template that no longer matches
 * the importer is worse than none — people trust it.
 *
 * The worked example lives on a SECOND sheet, and that is the load-bearing
 * decision here. `readSpreadsheet` reads the first worksheet and only the
 * first, so an example row on sheet two cannot become a delivery — whereas an
 * example row sitting under the header is a delivery to Praça da Sé in
 * somebody's production data the first time a dispatcher fills the file in
 * without deleting it. The example is worth having; a plausible fake delivery
 * that nobody ordered is not.
 *
 * The per-column notes stay on the data sheet, because the questions they
 * answer ("a data é qual formato?", "preciso da chave?") are asked at 6am by
 * somebody who will not read documentation and will not open sheet two.
 *
 * Built here rather than in the controller so the round trip can be tested:
 * the suite generates this file, reads it back through the importer, and only
 * a real workbook proves the model we publish is a model we accept.
 */
async function buildTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Trajetto";
  workbook.created = new Date();

  const data = workbook.addWorksheet(DATA_SHEET);

  layOutColumns(data);

  const example = workbook.addWorksheet(EXAMPLE_SHEET);

  layOutColumns(example);

  example.addRow(
    TEMPLATE_COLUMNS.reduce<Record<string, string>>((row, column) => {
      row[column.key] = column.example ?? "";

      return row;
    }, {}),
  );

  const buffer = await workbook.xlsx.writeBuffer();

  return Buffer.from(buffer);
}

export {
  DATA_SHEET,
  EXAMPLE_SHEET,
  TEMPLATE_CONTENT_TYPE,
  TEMPLATE_FILENAME,
  buildTemplateWorkbook,
};
