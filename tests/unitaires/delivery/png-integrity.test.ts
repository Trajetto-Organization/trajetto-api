import { deflateSync } from "node:zlib";

import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import { isDecodablePng } from "@/shared/services/png-integrity";

/**
 * A receipt photo with a valid PNG header and a corrupted body used to kill
 * the replica that rendered its PDF: pdfkit decodes RGBA PNGs through png-js,
 * which throws from inside an asynchronous zlib callback that no try/catch can
 * reach. `isDecodablePng` does the same decoding up front, synchronously.
 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  // png-js does not check CRCs, and neither does the gate; zeros will do.
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

function png(options: {
  width?: number;
  height?: number;
  colorType?: number;
  interlace?: number;
  pixels: Buffer;
}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width ?? 2, 0);
  header.writeUInt32BE(options.height ?? 2, 4);
  header[8] = 8; // bit depth
  header[9] = options.colorType ?? 6; // RGBA: the path that crashed
  header[12] = options.interlace ?? 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", options.pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Two RGBA rows of two pixels, each row led by filter byte 0. */
const validRows = Buffer.concat([
  Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]),
  Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255]),
]);

describe("isDecodablePng", () => {
  it("accepts a well-formed RGBA PNG", () => {
    expect(isDecodablePng(png({ pixels: deflateSync(validRows) }))).toBe(true);
  });

  it("accepts what a real encoder produces", async () => {
    expect(isDecodablePng(await QRCode.toBuffer("trajetto"))).toBe(true);
  });

  it("refuses a valid header over a body that does not inflate", () => {
    expect(
      isDecodablePng(png({ pixels: Buffer.from("lixo que não é deflate") })),
    ).toBe(false);
  });

  it("refuses rows with an unknown filter byte", () => {
    const rows = Buffer.from(validRows);
    rows[0] = 9;

    expect(isDecodablePng(png({ pixels: deflateSync(rows) }))).toBe(false);
  });

  it("refuses a body shorter than the header promises", () => {
    expect(
      isDecodablePng(png({ height: 50, pixels: deflateSync(validRows) })),
    ).toBe(false);
  });

  it("refuses a header that claims more pixels than it is worth decoding", () => {
    expect(
      isDecodablePng(
        png({ width: 100_000, height: 100_000, pixels: deflateSync(validRows) }),
      ),
    ).toBe(false);
  });

  it("refuses interlaced images and unknown colour types", () => {
    expect(
      isDecodablePng(png({ interlace: 1, pixels: deflateSync(validRows) })),
    ).toBe(false);
    expect(
      isDecodablePng(png({ colorType: 5, pixels: deflateSync(validRows) })),
    ).toBe(false);
  });

  it("refuses bytes that are not a PNG at all", () => {
    expect(isDecodablePng(Buffer.from("isto não é uma imagem"))).toBe(false);
  });
});


