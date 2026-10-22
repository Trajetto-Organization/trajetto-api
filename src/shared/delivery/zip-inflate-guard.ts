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

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes plus a comment of at most 64 KiB.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);

  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }

  return -1;
}

function assertZipInflatesWithin(buffer: Buffer, maxTotalBytes: number): void {
  if (buffer.length < 22) throw new Error("Not a zip archive");

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
    } else if (method === DEFLATED) {
      try {
        inflated = inflateRawSync(data, {
          maxOutputLength: remaining + 1,
        }).length;
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
}

export { SpreadsheetTooLargeError, assertZipInflatesWithin };
