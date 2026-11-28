import { describe, expect, it } from "vitest";

import {
  DUPLICATE_INVOICE_MESSAGE,
  DUPLICATE_ORDER_MESSAGE,
  ROW_FAILED_MESSAGE,
  advanceImportProgress,
  emptyImportProgress,
  importObjectContentType,
  importObjectKey,
  parseImportPayload,
  parseImportProgress,
  rowResultFor,
} from "@/modules/import/services/durable-import";
import type { ParsedRow } from "@/shared/delivery/spreadsheet-parser";

/**
 * The durable import's cursor and outcomes (plano-escala F3-23a). A run
 * that resumes after a SIGKILL rebuilds the report lines of the rows an
 * earlier attempt decided from one letter each: the words must be the ones
 * the in-memory path writes, and a cursor that does not add up is refused
 * rather than trusted.
 */
const row = (extra: Partial<ParsedRow>): ParsedRow =>
  ({
    line: 7,
    recipient_name: "Padaria Central",
    recipient_email_notice: null,
    invoice_key: null,
    code: null,
    route: null,
    ...extra,
  }) as ParsedRow;

describe("a decided row's report line", () => {
  it("reads an imported row with the e-mail it went in without", () => {
    expect(
      rowResultFor(
        row({ code: "PED-1", recipient_email_notice: "e-mail fora" }),
        "i",
      ),
    ).toEqual({
      line: 7,
      outcome: "imported",
      recipient_name: "Padaria Central",
      reference: "PED-1",
      message: "e-mail fora",
    });
  });

  it("reads a duplicate by the NF-e key when the row has one, by the order otherwise", () => {
    const key = "35260911222333000181550010000000011000000011";

    expect(rowResultFor(row({ invoice_key: key, code: "P" }), "d")).toEqual(
      expect.objectContaining({
        outcome: "duplicated",
        reference: key,
        message: DUPLICATE_INVOICE_MESSAGE,
      }),
    );
    expect(rowResultFor(row({ code: "PED-2" }), "d")).toEqual(
      expect.objectContaining({
        reference: "PED-2",
        message: DUPLICATE_ORDER_MESSAGE,
      }),
    );
    expect(DUPLICATE_INVOICE_MESSAGE).toBe(
      "Esta nota já havia sido importada.",
    );
    expect(DUPLICATE_ORDER_MESSAGE).toBe(
      "Este pedido já havia sido importado para este embarcador.",
    );
  });

  it("reads a failed write as the row the in-memory path refused", () => {
    expect(rowResultFor(row({ code: "PED-3" }), "x")).toEqual(
      expect.objectContaining({
        outcome: "invalid",
        reference: "PED-3",
        message: ROW_FAILED_MESSAGE,
      }),
    );
    expect(ROW_FAILED_MESSAGE).toBe("Não foi possível criar esta entrega.");
  });
});

describe("the cursor", () => {
  it("advances one row at a time, keeping the keyless deliveries", () => {
    const one = advanceImportProgress(emptyImportProgress(), 0, "i");
    const two = advanceImportProgress(one, 1, "i", {
      line: 3,
      deliveryId: "delivery-3",
    });
    const three = advanceImportProgress(two, 2, "d");

    expect(three).toEqual({
      v: 1,
      next: 3,
      outcomes: "iid",
      keyless: { "3": "delivery-3" },
      routes: {},
    });
    expect(() => advanceImportProgress(three, 5, "i")).toThrow(/out of order/);
  });

  it("is read back only when it adds up", () => {
    const valid = {
      v: 1,
      next: 2,
      outcomes: "ix",
      keyless: {},
      routes: {},
    };

    expect(parseImportProgress(valid)).toEqual(valid);
    expect(parseImportProgress({ ...valid, next: 3 })).toBeNull();
    expect(parseImportProgress({ ...valid, outcomes: "iz" })).toBeNull();
    expect(parseImportProgress({ ...valid, v: 2 })).toBeNull();
    expect(parseImportProgress(null)).toBeNull();
    expect(parseImportProgress({ v: 1, next: 0, outcomes: "" })).toEqual(
      emptyImportProgress(),
    );
  });
});

describe("the request and the stored file", () => {
  it("needs every field of the payload", () => {
    const payload = {
      importId: "i",
      objectKey: "spreadsheetImports/b/i.csv",
      filename: "carga.csv",
      shipperId: "s",
      userId: "u",
      timeZone: "America/Sao_Paulo",
    };

    expect(parseImportPayload(payload)).toEqual(payload);
    expect(parseImportPayload({ ...payload, userId: undefined })).toBeNull();
    expect(parseImportPayload("x")).toBeNull();
  });

  it("stores the file under the company, named after the import", () => {
    expect(importObjectKey("company", "import", "Carga.CSV")).toBe(
      "spreadsheetImports/company/import.csv",
    );
    expect(importObjectKey("company", "import", "carga.xlsx")).toBe(
      "spreadsheetImports/company/import.xlsx",
    );
    expect(importObjectContentType("spreadsheetImports/c/i.csv")).toBe(
      "text/csv",
    );
    expect(importObjectContentType("spreadsheetImports/c/i.xlsx")).toMatch(
      /spreadsheetml/,
    );
  });
});
