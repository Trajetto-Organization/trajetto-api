import { deflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/AppError";
import {
  MAX_SPREADSHEET_ROWS,
  readSpreadsheet,
} from "@/shared/delivery/spreadsheet-reader";

/**
 * What one spreadsheet upload may cost the process that also serves every
 * other tenant.
 *
 * An .xlsx is a zip of XML and XML compresses absurdly well: half a megabyte
 * of upload inflated to ~400 MB, which exceljs parsed on the event loop —
 * seconds of frozen replica and more than a gigabyte of memory, from one
 * dispatcher's import. Nothing capped the rows either.
 */

/** A minimal, valid zip with one deflated entry. */
function zipWith(name: string, content: Buffer): Buffer {
  const compressed = deflateRawSync(content);
  const nameBytes = Buffer.from(name, "latin1");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42); // local header at offset 0

  const localPart = Buffer.concat([local, nameBytes, compressed]);
  const centralPart = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, end]);
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("an .xlsx that inflates far beyond its size", () => {
  it("is refused before the parser sees it, quickly", async () => {
    // 64 MiB of XML-ish zeros in a few kilobytes of upload.
    const bomb = zipWith("xl/worksheets/sheet1.xml", Buffer.alloc(64 * 1024 * 1024));

    expect(bomb.length).toBeLessThan(200 * 1024);

    const started = Date.now();
    const error = await refusal(
      readSpreadsheet("entregas.xlsx", bomb.toString("base64")),
    );

    expect(error.statusCode).toBe(413);
    expect(error.code).toBe("SPREADSHEET_TOO_LARGE");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("a spreadsheet with more rows than a day of deliveries", () => {
  it("is refused as a CSV", async () => {
    const csv = ["pedido,destinatario"]
      .concat(Array.from({ length: MAX_SPREADSHEET_ROWS + 1 }, (_, i) => `P${i},Cliente ${i}`))
      .join("\n");

    const error = await refusal(
      readSpreadsheet("entregas.csv", Buffer.from(csv).toString("base64")),
    );

    expect(error.statusCode).toBe(413);
    expect(error.code).toBe("SPREADSHEET_TOO_MANY_ROWS");
  });

  it("is refused as an .xlsx", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Entregas");

    for (let index = 0; index <= MAX_SPREADSHEET_ROWS; index += 1) {
      sheet.addRow([`P${index}`, `Cliente ${index}`]);
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const error = await refusal(
      readSpreadsheet("entregas.xlsx", buffer.toString("base64")),
    );

    expect(error.code).toBe("SPREADSHEET_TOO_MANY_ROWS");
  }, 60_000);
});

describe("an ordinary spreadsheet", () => {
  it("still reads", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Entregas");

    sheet.addRow(["pedido", "destinatario"]);
    sheet.addRow(["P1", "Padaria Central"]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const rows = await readSpreadsheet("entregas.xlsx", buffer.toString("base64"));

    expect(rows).toEqual([
      ["pedido", "destinatario"],
      ["P1", "Padaria Central"],
    ]);
  });
});
