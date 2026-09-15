import { describe, expect, it } from "vitest";

import { parseDeliverySpreadsheet } from "@/shared/delivery/spreadsheet-parser";

/**
 * The spreadsheet a dispatcher pastes together at 6am.
 *
 * This is the first client's way in without an integration, which means it
 * meets real files: headers with accents, headers without, a stray "Vendedor"
 * column their ERP exported, a blank line where somebody hit enter twice, a
 * date written the way Brazilians write dates.
 *
 * The rule the whole thing is built on: one broken row never sinks the batch.
 * An import screen that refuses two hundred deliveries over one cell is an
 * import screen people stop using — and then they phone the numbers in instead.
 */
const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Número",
];

function sheet(...rows: unknown[][]) {
  return parseDeliverySpreadsheet([HEADER, ...rows]);
}

const GOOD = ["Padaria Central", "01001000", "São Paulo", "SP", "Praça da Sé", "100"];

describe("reading the header row", () => {
  it("accepts the headers exactly as the template publishes them", () => {
    const result = sheet(GOOD);

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it("accepts them without accents, in any case, with stray spacing", () => {
    // A dispatcher who typed "DESTINATARIO " has not made a mistake.
    const result = parseDeliverySpreadsheet([
      ["  destinatario ", "Cep", "CIDADE", "uf", "LOGRADOURO", "numero"],
      GOOD,
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows[0].recipient_name).toBe("Padaria Central");
  });

  it("accepts the aliases a customer's own sheet is likely to use", () => {
    const result = parseDeliverySpreadsheet([
      ["Cliente", "CEP", "Município", "Estado", "Endereço", "Nro"],
      GOOD,
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows[0].street).toBe("Praça da Sé");
  });

  it("reports a column it does not know without refusing the file", () => {
    // Customers' spreadsheets carry columns that mean nothing to us. Refusing
    // the file over a stray "Vendedor" would be refusing it for being real.
    const result = parseDeliverySpreadsheet([
      [...HEADER, "Vendedor"],
      [...GOOD, "Marcos"],
    ]);

    expect(result.unknownHeaders).toEqual(["Vendedor"]);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("refuses the whole file when a required column is missing", () => {
    // The one failure that IS fatal: every row would report the same thing,
    // and two hundred identical errors is a report nobody reads.
    const result = parseDeliverySpreadsheet([
      ["Destinatário", "Cidade"],
      ["Padaria Central", "São Paulo"],
    ]);

    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);

    expect(result.errors[0].message).toContain("CEP");
    expect(result.errors[0].message).toContain("UF");
    expect(result.errors[0].message).toContain("Logradouro");
  });

  it("says so plainly when the file is empty", () => {
    const result = parseDeliverySpreadsheet([]);

    expect(result.errors[0].message).toContain("vazia");
  });

  it("ignores a duplicated column instead of preferring the copy", () => {
    const result = parseDeliverySpreadsheet([
      [...HEADER, "Destinatário"],
      [...GOOD, "Cópia colada"],
    ]);

    expect(result.rows[0].recipient_name).toBe("Padaria Central");
  });
});

describe("one broken row never sinks the batch", () => {
  it("imports the good rows and reports the bad one by line", () => {
    const result = sheet(
      GOOD,
      ["Sem CEP", "", "São Paulo", "SP", "Rua X", "1"],
      ["Outra Padaria", "04567000", "São Paulo", "SP", "Rua Y", "2"],
    );

    expect(result.rows.map((row) => row.recipient_name)).toEqual([
      "Padaria Central",
      "Outra Padaria",
    ]);

    expect(result.errors).toHaveLength(1);

    // Line 3, because the header is line 1 — which is what the operator sees
    // in the corner of their screen and what they need to find it.
    expect(result.errors[0].line).toBe(3);
    expect(result.errors[0].column).toBe("CEP");
  });

  it("reports every problem in a row, not just the first", () => {
    // The operator fixes the row once. Reporting one error at a time turns one
    // correction into four uploads.
    const result = sheet(["", "123", "", "SPX", "", ""]);

    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.rows).toEqual([]);
  });

  it("skips a blank line without calling it an error", () => {
    // Somebody hit enter twice. That is spacing, not a delivery with no name.
    const result = sheet(GOOD, ["", "", "", "", "", ""], GOOD);

    expect(result.rows).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });
});

describe("the fields as people actually type them", () => {
  const withColumn = (header: string, value: unknown) =>
    parseDeliverySpreadsheet([
      [...HEADER, header],
      [...GOOD, value],
    ]);

  it("strips punctuation from the CEP and the document", () => {
    const result = parseDeliverySpreadsheet([
      [...HEADER, "Documento"],
      ["Padaria Central", "01001-000", "São Paulo", "SP", "Praça da Sé", "100", "11.222.333/0001-81"],
    ]);

    expect(result.rows[0].cep).toBe("01001000");
    expect(result.rows[0].recipient_document).toBe("11222333000181");
  });

  it("refuses a document that is neither a CPF nor a CNPJ", () => {
    const result = withColumn("Documento", "12345");

    expect(result.errors[0].column).toBe("Documento");
    expect(result.rows).toEqual([]);
  });

  it("reads a date the way a Brazilian writes it", () => {
    const result = withColumn("Data prevista", "16/09/2026");

    expect(result.rows[0].scheduled_date?.toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
  });

  it("reads a date the way every export writes it", () => {
    const result = withColumn("Data prevista", "2026-09-16");

    expect(result.rows[0].scheduled_date?.toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
  });

  it("refuses a date it cannot read rather than guessing the day", () => {
    // A date silently read as the wrong day sends a truck out tomorrow
    // instead of today.
    const result = withColumn("Data prevista", "16 de setembro");

    expect(result.errors[0].column).toBe("Data prevista");
  });

  it("reads a Date object, which is what a formatted cell produces", () => {
    const result = withColumn("Data prevista", new Date("2026-09-16T00:00:00Z"));

    expect(result.rows[0].scheduled_date?.toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
  });

  it("takes the comma as the decimal, and the dot as thousands", () => {
    const result = parseDeliverySpreadsheet([
      [...HEADER, "Item", "Valor unitário"],
      [...GOOD, "Caixa de pão", "1.234,56"],
    ]);

    expect(result.rows[0].item?.unit_value).toBe(1234.56);
  });

  it("reads exceljs rich text and formula cells", () => {
    // A cell somebody bolded half of, and a cell that is a formula.
    const result = parseDeliverySpreadsheet([
      HEADER,
      [
        { richText: [{ text: "Padaria " }, { text: "Central" }] },
        { result: "01001000" },
        "São Paulo",
        "SP",
        "Praça da Sé",
        "100",
      ],
    ]);

    expect(result.errors).toEqual([]);
    expect(result.rows[0].recipient_name).toBe("Padaria Central");
    expect(result.rows[0].cep).toBe("01001000");
  });
});

describe("what kind of stop this is", () => {
  const withKind = (value: string) =>
    parseDeliverySpreadsheet([
      ["Tipo", ...HEADER],
      [value, ...GOOD],
    ]);

  it("defaults to a delivery when nobody said", () => {
    expect(withKind("").rows[0].kind).toBe("DELIVERY");
  });

  it("understands “coleta”", () => {
    expect(withKind("Coleta").rows[0].kind).toBe("PICKUP");
  });

  it("refuses a word it does not know", () => {
    const result = withKind("devolução");

    expect(result.errors[0].column).toBe("Tipo");
  });
});

describe("the columns that create a route", () => {
  const ROUTE_HEADER = [...HEADER, "Rota", "CNH do motorista", "Placa do veículo"];

  it("carries the route when the columns are filled", () => {
    const result = parseDeliverySpreadsheet([
      ROUTE_HEADER,
      [...GOOD, "Zona Sul — manhã", "012.345.678-90", "abc1d23"],
    ]);

    expect(result.rows[0].route).toEqual({
      name: "Zona Sul — manhã",
      date: null,
      driverCnh: "01234567890",
      vehiclePlate: "ABC1D23",
    });
  });

  it("carries no route when none of them is", () => {
    expect(sheet(GOOD).rows[0].route).toBeNull();
  });

  it("refuses a route with nobody to drive it", () => {
    // Naming a route with no driver creates a plan that can never be
    // released. Saying so now is better than saying so at the release.
    const result = parseDeliverySpreadsheet([
      ROUTE_HEADER,
      [...GOOD, "Zona Sul — manhã", "", ""],
    ]);

    expect(result.errors[0].column).toBe("CNH do motorista");
    expect(result.rows).toEqual([]);
  });

  it("treats a plate alone as wanting a route, and asks for the driver", () => {
    const result = parseDeliverySpreadsheet([
      ROUTE_HEADER,
      [...GOOD, "", "", "ABC1D23"],
    ]);

    expect(result.errors[0].column).toBe("CNH do motorista");
  });
});

describe("the optional item on the row", () => {
  it("takes a described item with no quantity as one of it", () => {
    const result = parseDeliverySpreadsheet([
      [...HEADER, "Item"],
      [...GOOD, "Caixa de pão"],
    ]);

    expect(result.rows[0].item).toEqual({
      description: "Caixa de pão",
      quantity: 1,
      unit: null,
      unit_value: null,
    });
  });

  it("refuses a quantity with nothing to count", () => {
    const result = parseDeliverySpreadsheet([
      [...HEADER, "Item", "Quantidade"],
      [...GOOD, "", "3"],
    ]);

    expect(result.errors[0].column).toBe("Item");
  });

  it("carries no item when the columns are empty", () => {
    expect(sheet(GOOD).rows[0].item).toBeNull();
  });
});
