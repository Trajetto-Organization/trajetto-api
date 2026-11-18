import { crc32, deflateRawSync } from "node:zlib";

/**
 * .xlsx files written by hand, for the reader's tests: the XML other
 * generators write (inline strings, cells without `r`, rows out of order),
 * which exceljs's writer never produces, and workbooks of any size built in
 * milliseconds instead of exceljs's seconds.
 */

/** A zip of deflated entries, in this order, with their CRCs. */
function zipOf(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(parts)) {
    const content = Buffer.from(text, "utf8");
    const compressed = deflateRawSync(content);
    const nameBytes = Buffer.from(name, "latin1");
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    const entry = Buffer.concat([local, nameBytes, compressed]);

    locals.push(entry);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += entry.length;
  }

  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralPart, end]);
}

const MAIN =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const WORKSHEET_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

/** A workbook written by hand: the XML other generators write. */
function handWrittenXlsx({
  sheet,
  workbookPr = "",
  styles = true,
  sharedStrings = ["compartilhada"],
  target = "worksheets/sheet1.xml",
}: {
  sheet: string;
  workbookPr?: string;
  styles?: boolean;
  sharedStrings?: string[] | null;
  target?: string;
}): Buffer {
  const parts: Record<string, string> = {
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook ${MAIN}>${workbookPr}<sheets><sheet name="Entregas" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${WORKSHEET_REL}" Target="${target}"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet ${MAIN}><sheetData>${sheet}</sheetData></worksheet>`,
  };

  if (styles) {
    parts["xl/styles.xml"] =
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${MAIN}>` +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
      '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>' +
      '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>';
  }

  if (sharedStrings) {
    parts["xl/sharedStrings.xml"] =
      `<?xml version="1.0" encoding="UTF-8"?><sst ${MAIN} count="${sharedStrings.length}">` +
      sharedStrings.map((text) => `<si><t>${text}</t></si>`).join("") +
      "</sst>";
  }

  return zipOf(parts);
}

/** `A`, `B` … `Z`, `AA` …: the column letters of a 1-based column. */
function columnLetters(column: number): string {
  let letters = "";

  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }

  return letters;
}

/**
 * A workbook of `rows` lines × `columns` cells, the first line a header,
 * every cell a shared string (`value(row, column)`) or, when it returns a
 * number, a number — the XML Excel writes, in a fraction of the time
 * exceljs's writer takes for hundreds of thousands of cells.
 */
function generatedXlsx({
  rows,
  columns,
  value,
}: {
  rows: number;
  columns: number;
  value: (row: number, column: number) => string | number;
}): Buffer {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sheet: string[] = [];

  const shared = (text: string) => {
    let at = index.get(text);

    if (at === undefined) {
      at = strings.length;
      strings.push(text);
      index.set(text, at);
    }

    return at;
  };

  for (let row = 1; row <= rows; row += 1) {
    const cells: string[] = [];

    for (let column = 1; column <= columns; column += 1) {
      const ref = `${columnLetters(column)}${row}`;
      const content = row === 1 ? `Coluna ${column}` : value(row, column);

      cells.push(
        typeof content === "number"
          ? `<c r="${ref}"><v>${content}</v></c>`
          : `<c r="${ref}" t="s"><v>${shared(content)}</v></c>`,
      );
    }

    sheet.push(`<row r="${row}">${cells.join("")}</row>`);
  }

  return zipOf({
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook ${MAIN}><sheets><sheet name="Entregas" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${WORKSHEET_REL}" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst ${MAIN} count="${strings.length}">${strings.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet ${MAIN}><sheetData>${sheet.join("")}</sheetData></worksheet>`,
  });
}

export { MAIN, WORKSHEET_REL, generatedXlsx, handWrittenXlsx, zipOf };
