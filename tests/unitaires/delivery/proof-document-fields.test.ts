import { describe, expect, it } from "vitest";

import {
  documentKind,
  formatCep,
  formatCnpj,
  formatDecimalComma,
  issuerCnpjFromKey,
  recipientDocumentLabel,
  recipientDocumentValue,
  stampLine,
} from "@/shared/delivery/proof-document-fields";

/**
 * The small rules behind the validated proof model's fields (decision 14.8,
 * design §3.1). A real access key layout: cUF(2) AAMM(4) CNPJ(14) mod(2)
 * serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1).
 */
const ISSUER = "31358035000120";

function key(model: string, cnpj = ISSUER): string {
  return `32${"2609"}${cnpj}${model}002000045515100045515`.padEnd(44, "0").slice(0, 44);
}

describe("the document kind", () => {
  it.each([
    ["55", "NFe"],
    ["65", "NFCe"],
    ["57", "CTe"],
  ])("reads model %s from the access key as %s", (model, kind) => {
    expect(key(model)).toHaveLength(44);
    expect(
      documentKind({ invoice_key: key(model), invoice_number: "45515", code: "PED-1" }),
    ).toEqual({ kind, number: "45515" });
  });

  it("is a generic NF with a number and no readable key", () => {
    expect(documentKind({ invoice_key: "123", invoice_number: "77", code: null })).toEqual({
      kind: "NF",
      number: "77",
    });
    expect(documentKind({ invoice_key: key("99"), invoice_number: "77", code: null })).toEqual({
      kind: "NF",
      number: "77",
    });
  });

  it("is the order, numbered by its code, without key or number", () => {
    expect(documentKind({ invoice_key: null, invoice_number: null, code: " PED-9 " })).toEqual({
      kind: "Pedido",
      number: "PED-9",
    });
    expect(documentKind({ invoice_key: null, invoice_number: "  ", code: null })).toEqual({
      kind: "Pedido",
      number: null,
    });
  });
});

describe("the issuer's CNPJ inside the access key", () => {
  it("is digits 7 to 20 when their check digits hold", () => {
    expect(issuerCnpjFromKey(key("55"))).toBe(ISSUER);
    // Masked keys (with spaces) are read by their digits.
    expect(issuerCnpjFromKey(key("55").replace(/(\d{4})/g, "$1 "))).toBe(ISSUER);
  });

  it("is never invented: wrong check digits, short keys and nothing give null", () => {
    expect(issuerCnpjFromKey(key("55", "31358035000121"))).toBeNull();
    expect(issuerCnpjFromKey(key("55").slice(0, 43))).toBeNull();
    expect(issuerCnpjFromKey(null)).toBeNull();
  });
});

describe("the recipient's document", () => {
  it("is labelled by what it is", () => {
    expect(recipientDocumentLabel("30.970.502/0001-06")).toBe("CNPJ");
    expect(recipientDocumentLabel("097.974.177-78")).toBe("CPF");
    expect(recipientDocumentLabel("RG 12.345")).toBe("Documento");
    expect(recipientDocumentLabel(null)).toBe("Documento");
  });

  it("prints digits for a CPF or CNPJ, the raw value otherwise, and null when empty", () => {
    expect(recipientDocumentValue("30.970.502/0001-06")).toBe("30970502000106");
    expect(recipientDocumentValue("RG 12.345")).toBe("RG 12.345");
    expect(recipientDocumentValue("  ")).toBeNull();
  });
});

describe("formatting", () => {
  it("uses the decimal comma for coordinates", () => {
    expect(formatDecimalComma(-20.3502181, 4)).toBe("-20,3502");
    expect(formatDecimalComma(-40.30376, 4)).toBe("-40,3038");
  });

  it("masks CNPJ and CEP for reading", () => {
    expect(formatCnpj("11222333000181")).toBe("11.222.333/0001-81");
    expect(formatCep("29106100")).toBe("29106-100");
    expect(formatCep(null)).toBeNull();
  });
});

describe("the stamp under the photo", () => {
  it("reads like the model's: brand, moment, place, DRIVER, document", () => {
    expect(
      stampLine({
        brand: "Trajetto",
        moment: "30/09/2026 13:30:08",
        latitude: -20.35012,
        longitude: -40.30371,
        driverName: "Rogério Viana Bezerra",
        kind: "NFe",
        number: "45515",
      }),
    ).toBe("Trajetto - 30/09/2026 13:30:08  -20,3501, -40,3037  ROGÉRIO VIANA BEZERRA  NFe 45515");
  });

  it("says the GPS was unavailable instead of printing zeros, and drops a missing driver", () => {
    expect(
      stampLine({
        brand: "Trajetto",
        moment: "30/09/2026 13:30:08",
        latitude: null,
        longitude: null,
        driverName: null,
        kind: "Pedido",
        number: null,
      }),
    ).toBe("Trajetto - 30/09/2026 13:30:08  GPS indisponível  Pedido");
  });
});
