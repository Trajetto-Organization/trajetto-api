import { inflateRawSync } from "node:zlib";

/**
 * Refuses an .xlsx whose contents inflate past `maxTotalBytes`, before any
 * parser sees it.
 *
 * An .xlsx is a zip of XML, and XML compresses absurdly well: half a megabyte
 * of upload — well inside the request limit — inflated to ~400 MB, and
 * exceljs then parsed all of it on the event loop, freezing the replica for
 * seconds and pushing it past a gigabyte of memory. One import from any
 * dispatcher, in any company, stalled HTTP, sockets and workers for everyone
 * on that replica.
 *
 * The sizes a zip DECLARES are not trusted: each entry is actually inflated,
 * with Node's own `maxOutputLength` as the ceiling, so a lying header fails
 * the same way an honest large one does. The inflated bytes are thrown away;
 * the budget is small enough that doing the work twice costs little.
 */
class SpreadsheetTooLargeError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

/** What the worksheets of the archive hold, counted while inflating them. */
interface WorksheetTally {
  /** `<c>` elements: every cell exceljs will build an object for. */
  cells: number;

  /** `<row>` elements, empty styled rows included. */
  rows: number;
}

const WORKSHEET_ENTRY = /^xl\/worksheets\/[^/]+\.xml$/;

const LT = 0x3c;
const COLON = 0x3a;

/** A byte that ends an XML tag name: space, tab, CR, LF, `>` or `/`. */
function endsName(byte: number | undefined): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0d ||
    byte === 0x0a ||
    byte === 0x3e ||
    byte === 0x2f
  );
}

/**
 * Counts the cell and row elements of one worksheet's XML, prefixed or not
 * (`<c r="A1">`, `<x:c r="A1">`), by walking its tags with the native
 * indexOf: tens of milliseconds for a sheet that exceljs takes a second and
 * hundreds of megabytes to load.
 */
function tallyWorksheet(xml: Buffer, tally: WorksheetTally): void {
  let at = xml.indexOf(LT);

  while (at !== -1) {
    let name = at + 1;
    let end = name;

    while (end < xml.length && !endsName(xml[end])) {
      if (xml[end] === COLON) name = end + 1;
      end += 1;
    }

    const length = end - name;

    if (length === 1 && xml[name] === 0x63) {
      tally.cells += 1;
    } else if (
      length === 3 &&
      xml[name] === 0x72 &&
      xml[name + 1] === 0x6f &&
      xml[name + 2] === 0x77
    ) {
      tally.rows += 1;
    }

    at = xml.indexOf(LT, end);
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes plus a comment of at most 64 KiB.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);

  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }

  return -1;
}

/**
 * Returns what the worksheets hold (cells and rows, every sheet together),
 * counted on the same inflated bytes, so the caller can refuse a sheet too big
 * to load BEFORE exceljs builds it: the inflated size alone let a 2.6 MB,
 * 20k × 50 workbook through, and loading it cost +329 MB of heap and a second
 * of frozen event loop.
 */
function assertZipInflatesWithin(
  buffer: Buffer,
  maxTotalBytes: number,
): WorksheetTally {
  if (buffer.length < 22) throw new Error("Not a zip archive");

  const tally: WorksheetTally = { cells: 0, rows: 0 };

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("Not a zip archive");

  const entries = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  let remaining = maxTotalBytes;

  for (let entry = 0; entry < entries; entry += 1) {
    if (cursor + 46 > buffer.length) throw new Error("Truncated zip archive");
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt zip central directory");
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("latin1");

    cursor += 46 + nameLength + extraLength + commentLength;

    // ZIP64 markers: never needed at spreadsheet sizes, and a way to hide
    // the real size behind a field this reader does not follow.
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new SpreadsheetTooLargeError("ZIP64 entries are not accepted");
    }

    if (localOffset + 30 > buffer.length)
      throw new Error("Truncated zip archive");
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error("Corrupt zip local header");
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    let inflated: number;

    if (method === STORED) {
      inflated = data.length;

      if (WORKSHEET_ENTRY.test(entryName)) tallyWorksheet(data, tally);
    } else if (method === DEFLATED) {
      try {
        const bytes = inflateRawSync(data, {
          maxOutputLength: remaining + 1,
        });

        inflated = bytes.length;

        if (WORKSHEET_ENTRY.test(entryName)) tallyWorksheet(bytes, tally);
      } catch (error) {
        // Past the ceiling, Node refuses with a RangeError before allocating.
        if (error instanceof RangeError) {
          throw new SpreadsheetTooLargeError("Spreadsheet inflates too large");
        }

        throw error;
      }
    } else {
      throw new Error(`Unsupported zip compression method ${method}`);
    }

    remaining -= inflated;

    if (remaining < 0) {
      throw new SpreadsheetTooLargeError("Spreadsheet inflates too large");
    }
  }

  return tally;
}

export {
  SpreadsheetTooLargeError,
  assertZipInflatesWithin,
  tallyWorksheet,
  type WorksheetTally,
};
