import { StringDecoder } from "node:string_decoder";

import Column from "exceljs/lib/doc/column";
import Row from "exceljs/lib/doc/row";
import parseSax from "exceljs/lib/utils/parse-sax";
import WorkbookXform from "exceljs/lib/xlsx/xform/book/workbook-xform";
import RelationshipsXform from "exceljs/lib/xlsx/xform/core/relationships-xform";
import WorksheetXform from "exceljs/lib/xlsx/xform/sheet/worksheet-xform";
import SharedStringsXform from "exceljs/lib/xlsx/xform/strings/shared-strings-xform";
import StylesXform from "exceljs/lib/xlsx/xform/style/styles-xform";

import {
  inflateZipEntry,
  zipEntries,
  type ZipEntry,
} from "./zip-inflate-guard";

/**
 * The first sheet of an .xlsx, one row at a time (plano-escala F3-23b).
 *
 * exceljs's `xlsx.load` builds an object for every cell of every sheet
 * before the first row can be read: ~350 bytes a cell, so a 20k × 26
 * workbook held 187 MB of heap and a 20k × 40 one 278 MB. That was the
 * price inside the 768 MB main heap; on the reading thread, whose ceiling
 * is 96 MB on the staging api and 256 MB in production (U-15), files well
 * inside the reader's own limits ran out of heap and closed the import with
 * a 413 they never got before.
 *
 * Here the same exceljs classes `xlsx.load` uses parse the same parts — the
 * workbook, its relationships, the styles, the shared strings and the
 * sheet — and each `<row>` is reconciled and turned into exceljs's own Row
 * the moment it closes, handed over and dropped. Only the shared strings
 * stay for the whole read (the rows point into them), so the 20k × 40
 * workbook reads in under 64 MB. The rows are the very values the whole
 * load gives (tests/unitaires/delivery/xlsx-row-reader.test.ts compares
 * them), with three things left to the whole load because only it knows
 * them before the rows go out:
 *  - merged cells, whose slaves repeat the master's value (`<mergeCells>`
 *    comes after the rows);
 *  - hyperlinks, which turn a value into `{ text, hyperlink }` (likewise);
 *  - rows out of number order, which it reads back sorted (and a row with
 *    no number, which makes it throw).
 * Those throw WholeLoadNeeded — as does any shape of workbook this reader
 * does not follow — and the caller reads the file with `xlsx.load`, as it
 * always did.
 *
 * Unlike the whole load, it never opens the other sheets: a workbook whose
 * second sheet is broken still gives its first one.
 */
class WholeLoadNeeded extends Error {}

/**
 * The worksheet parts the whole load reads (xlsx.js, unanchored there too):
 * a relationship to anything else — a chartsheet — is not a sheet to read.
 */
const WORKSHEET_PART = /xl\/worksheets\/sheet(\d+)[.]xml/;

/**
 * Sheet ids the whole load lists among `workbook.worksheets`: it files each
 * sheet at `_worksheets[id]` and reads them back from index 1, so an id that
 * is not a small positive integer never shows. Any other id, or two sheets
 * with one id, and the order is the whole load's to decide.
 */
const MAX_SHEET_ID = 65_535;

/** Excel's last row: a number past it is a file the whole load decides. */
const MAX_ROW_NUMBER = 1_048_576;

/** Bytes of XML handed to the SAX parser at a time. */
const XML_SLICE_BYTES = 64 * 1024;

/** The XML of a part as text, a slice at a time, never splitting a char. */
async function* xmlSlices(bytes: Buffer): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");

  for (let at = 0; at < bytes.length; at += XML_SLICE_BYTES) {
    const text = decoder.write(bytes.subarray(at, at + XML_SLICE_BYTES));

    if (text) yield text;
  }

  const rest = decoder.end();

  if (rest) yield rest;
}

function parsePart<T>(
  xform: { parse(events: AsyncIterable<unknown>): Promise<T> },
  bytes: Buffer,
): Promise<T> {
  return xform.parse(parseSax(xmlSlices(bytes)));
}

/**
 * The archive's files by name, as the whole load sees them: folders out, one
 * leading slash dropped, the last of two entries with one name winning.
 */
function zipParts(buffer: Buffer): Map<string, ZipEntry> {
  const parts = new Map<string, ZipEntry>();

  for (const entry of zipEntries(buffer)) {
    if (entry.name.endsWith("/")) continue;

    parts.set(entry.name.replace(/^\//, ""), entry);
  }

  return parts;
}

/**
 * True when the XML has an element of exactly this name, unprefixed (exceljs
 * reads only unprefixed names, in both readers).
 */
function hasElement(xml: Buffer, name: string): boolean {
  const open = Buffer.from(`<${name}`, "latin1");
  let at = xml.indexOf(open);

  while (at !== -1) {
    const next = xml[at + open.length];

    // Space, tab, CR, LF, `>` or `/`: the name ends here.
    if (
      next === 0x20 ||
      next === 0x09 ||
      next === 0x0d ||
      next === 0x0a ||
      next === 0x3e ||
      next === 0x2f
    ) {
      return true;
    }

    at = xml.indexOf(open, at + open.length);
  }

  return false;
}

/**
 * The part the whole load returns as `workbook.worksheets[0]`: the first
 * sheet of workbook.xml, in its order, whose relationship points at a
 * worksheet part present in the archive — hidden sheets included, as there.
 */
function firstSheetPart(
  workbook: Awaited<ReturnType<WorkbookXform["parse"]>>,
  relationships: Awaited<ReturnType<RelationshipsXform["parse"]>>,
  parts: Map<string, ZipEntry>,
): string {
  const sheets = workbook?.sheets ?? [];
  const ids = new Set<number>();

  for (const sheet of sheets) {
    if (
      !Number.isInteger(sheet.id) ||
      sheet.id < 1 ||
      sheet.id > MAX_SHEET_ID ||
      ids.has(sheet.id)
    ) {
      throw new WholeLoadNeeded("sheet ids the whole load orders itself");
    }

    ids.add(sheet.id);
  }

  // A plain object, as in WorkbookXform.reconcile: the same lookup, misses
  // included.
  const byId: Record<string, { Target: string } | undefined> = {};

  for (const relationship of relationships ?? []) {
    byId[relationship.Id] = relationship;
  }

  const found: string[] = [];

  for (const sheet of sheets) {
    const relationship = byId[sheet.rId];

    if (!relationship) continue;

    const part = `xl/${relationship.Target.replace(/^(\s|\/xl\/)+/, "")}`;

    if (WORKSHEET_PART.test(part) && parts.has(part)) found.push(part);
  }

  if (found.length === 0) throw new WholeLoadNeeded("no sheet to read");

  if (new Set(found).size !== found.length) {
    throw new WholeLoadNeeded("two sheets on one part");
  }

  return found[0];
}

/**
 * Hands every row with values of the workbook's first sheet to `onRow`, in
 * order, as exceljs's `row.values.slice(1)` — the matrix the whole load's
 * `eachRow({ includeEmpty: false })` gives. Throws WholeLoadNeeded (rows
 * may have been handed by then) when the whole load must decide; exceljs's
 * own errors pass through; so does whatever `onRow` throws.
 */
async function readFirstSheetRows(
  buffer: Buffer,
  maxInflatedBytes: number,
  onRow: (values: unknown[]) => void,
): Promise<void> {
  const parts = zipParts(buffer);

  const part = (name: string): Buffer | undefined => {
    const entry = parts.get(name);

    return entry && inflateZipEntry(entry, maxInflatedBytes);
  };

  const workbookXml = part("xl/workbook.xml");
  const relationshipsXml = part("xl/_rels/workbook.xml.rels");

  if (!workbookXml || !relationshipsXml) {
    throw new WholeLoadNeeded("no workbook part");
  }

  const workbook = await parsePart(new WorkbookXform(), workbookXml);
  const relationships = await parsePart(
    new RelationshipsXform(),
    relationshipsXml,
  );

  const sheetXml = part(firstSheetPart(workbook, relationships, parts));

  if (!sheetXml) throw new WholeLoadNeeded("no sheet to read");

  if (hasElement(sheetXml, "mergeCell") || hasElement(sheetXml, "hyperlink")) {
    throw new WholeLoadNeeded("merged cells or hyperlinks");
  }

  // As xlsx.load: without the part, no styles (no dates) or no strings.
  const stylesXml = part("xl/styles.xml");
  const sharedStringsXml = part("xl/sharedStrings.xml");

  let styles: StylesXform | undefined;
  let sharedStrings: SharedStringsXform | undefined;

  if (stylesXml) {
    styles = new StylesXform();
    await parsePart(styles, stylesXml);
  }

  if (sharedStringsXml) {
    sharedStrings = new SharedStringsXform();
    await parsePart(sharedStrings, sharedStringsXml);
  }

  // What WorksheetXform.reconcile gives each row's reconcile: shared
  // formulas registered in document order, no hyperlink (none, checked
  // above), and no comment (a comment never changes a value).
  const options = {
    styles,
    sharedStrings,
    date1904: workbook?.properties?.date1904,
    formulae: {},
    hyperlinkMap: {},
    commentsMap: {},
  };

  const sheet = new WorksheetXform();
  const { sheetData } = sheet.map;
  const rowXform = sheetData.childXform;

  // The worksheet a Row asks its columns of; a cell's value never depends
  // on its column.
  const columns: Column[] = [];
  const worksheet = {
    getColumn: (number: number) =>
      (columns[number] ??= new Column(worksheet, number)),
  };

  let previous = 0;

  const closeInSheetData = sheetData.parseClose.bind(sheetData);

  // Each `<row>` the list closes, taken out of it at once: the whole load
  // keeps them all, which is the memory this reader does not spend.
  sheetData.parseClose = (name: string) => {
    const open = closeInSheetData(name);
    const closed = sheetData.model;

    if (closed && closed.length > 0) {
      for (const model of closed.splice(0)) {
        rowXform.reconcile(model, options);

        const { number } = model;

        // The whole load files each row at `_rows[number - 1]` and reads
        // them back in number order; a row with no number makes it throw.
        // Anything but a rising positive number is its to decide.
        if (
          !Number.isInteger(number) ||
          number <= previous ||
          number > MAX_ROW_NUMBER
        ) {
          throw new WholeLoadNeeded("rows out of order");
        }

        previous = number;

        const row = new Row(worksheet, number);

        row.model = model;

        if (row.hasValues) onRow(row.values.slice(1));
      }
    }

    return open;
  };

  await parsePart(sheet, sheetXml);

  // The scan above missed nothing exceljs reads; kept so it never could.
  if (
    sheet.map.mergeCells.model?.length ||
    sheet.map.hyperlinks.model?.length
  ) {
    throw new WholeLoadNeeded("merged cells or hyperlinks");
  }
}

export { WholeLoadNeeded, readFirstSheetRows };
