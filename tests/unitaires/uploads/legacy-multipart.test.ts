import { describe, expect, it } from "vitest";

import {
  parseMultipartFormData,
  sniffImage,
} from "@/shared/http/legacy-multipart";

/**
 * The parser behind the temporary multipart adapter (GAP5-1).
 *
 * It only has to read what React Native's FormData writes, but it reads it
 * from the network, so everything it does not recognise is refused rather
 * than guessed at.
 */
const BOUNDARY = "----RNFormDataBoundaryabc123";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x0d, 0x0a, 0x2d, 0x2d, 0x00,
]);

function body(...parts: Array<Buffer | string>): Buffer {
  return Buffer.concat(
    parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)),
  );
}

function field(name: string, value: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function file(name: string, bytes: Buffer): Buffer {
  return body(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    bytes,
    "\r\n",
  );
}

const CLOSE = `--${BOUNDARY}--\r\n`;

describe("parseMultipartFormData", () => {
  it("splits text fields from photos, even under the same name", () => {
    const parsed = parseMultipartFormData(
      body(
        field("current_mileage", "12.345"),
        field("tires_condition", "good"),
        file("current_mileage", JPEG),
        field("client_submission_id", "018fd960-0000-7000-8000-0000000000f1"),
        CLOSE,
      ),
      CONTENT_TYPE,
      { maxFiles: 20 },
    );

    expect(parsed.fields).toEqual({
      current_mileage: "12.345",
      tires_condition: "good",
      client_submission_id: "018fd960-0000-7000-8000-0000000000f1",
    });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].fieldName).toBe("current_mileage");

    // Binary content that happens to contain CRLF and dashes survives intact.
    expect(parsed.files[0].bytes.equals(JPEG)).toBe(true);
  });

  it("accepts a quoted boundary and keeps UTF-8 text", () => {
    const parsed = parseMultipartFormData(
      body(field("notes", "Pneu dianteiro com desgaste — atenção"), CLOSE),
      `multipart/form-data; boundary="${BOUNDARY}"`,
      { maxFiles: 1 },
    );

    expect(parsed.fields.notes).toBe("Pneu dianteiro com desgaste — atenção");
  });

  it("refuses more photos than the route allows", () => {
    expect(() =>
      parseMultipartFormData(
        body(file("odometer_photo", JPEG), file("odometer_photo", JPEG), CLOSE),
        CONTENT_TYPE,
        { maxFiles: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "UPLOAD_FILE_LIMIT_EXCEEDED" }));
  });

  it("refuses a body it cannot frame", () => {
    for (const broken of [
      body(field("a", "1")), // never closed
      body("no boundary at all"),
      body(
        `--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nx\r\n`,
        CLOSE,
      ), // no name
    ]) {
      expect(() =>
        parseMultipartFormData(broken, CONTENT_TYPE, { maxFiles: 1 }),
      ).toThrow(expect.objectContaining({ code: "MALFORMED_MULTIPART" }));
    }

    expect(() =>
      parseMultipartFormData(body(CLOSE), "multipart/form-data", {
        maxFiles: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "MALFORMED_MULTIPART" }));
  });

  it("drops field names that would reach a prototype", () => {
    const parsed = parseMultipartFormData(
      body(field("__proto__", "polluted"), field("liters_amount", "40"), CLOSE),
      CONTENT_TYPE,
      { maxFiles: 1 },
    );

    expect(parsed.fields).toEqual({ liters_amount: "40" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses an oversized text field", () => {
    expect(() =>
      parseMultipartFormData(
        body(field("notes", "x".repeat(70 * 1024)), CLOSE),
        CONTENT_TYPE,
        { maxFiles: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "MALFORMED_MULTIPART" }));
  });
});

describe("sniffImage", () => {
  it("names the image by its signature, never by what the part declared", () => {
    expect(sniffImage(JPEG)).toEqual({
      contentType: "image/jpeg",
      extension: "jpg",
    });

    expect(
      sniffImage(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toEqual({ contentType: "image/png", extension: "png" });

    expect(
      sniffImage(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")),
    ).toEqual({
      contentType: "image/webp",
      extension: "webp",
    });
  });

  it("refuses everything else", () => {
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
