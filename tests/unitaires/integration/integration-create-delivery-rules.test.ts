import { describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";
import { createDeliverySchema } from "@/schemas/create-delivery-schema";
import {
  isSameSubmission,
  itemAtColumnScale,
  type DeliveryDraft,
  type DraftItem,
  type StoredDelivery,
} from "@/modules/integration/usecases/create-delivery/replay-fingerprint";
import { readIntegrationIdempotencyKey } from "@/modules/integration/usecases/create-delivery/integration-idempotency-key";

/**
 * The pure rules of POST /integration/v1/deliveries (decision 5.10): what
 * counts as "the same body" for a replay, which Idempotency-Key is accepted,
 * and how a refused body reads to an integrator. The HTTP path and the
 * database are in tests/E2E/integration-create-delivery.test.ts.
 */
const SHIPPER = "018f6000-0000-7000-8000-0000000000f1";

const body = {
  shipper_id: SHIPPER,
  code: "PED-1",
  recipient_name: "Padaria Central",
  cep: "01001-000",
  city: "São Paulo",
  uf: "sp",
  street: "Praça da Sé",
  scheduled_date: "2026-09-24",
  items: [
    { description: "Farinha", quantity: 1.0005, unit_value: 10.005 },
    { description: "Açúcar", quantity: 2, unit: "" },
  ],
};

/** The draft the use case builds from a parsed body. */
function draftOf(raw: unknown): DeliveryDraft {
  const {
    shipper_id,
    shipper_cnpj: _cnpj,
    items,
    ...fields
  } = parseIntegrationDeliveryBody(raw);

  return {
    ...fields,
    items: items?.map(itemAtColumnScale),
    shipperId: shipper_id ?? null,
  };
}

/**
 * The row the create writes for that body, read back as Prisma hands it
 * over (decimals). That Postgres keeps exactly what is written is proven
 * against the real database in tests/E2E/integration-create-delivery.test.ts.
 */
const stored: StoredDelivery = {
  shipperId: SHIPPER,
  apiKeyId: "018f6000-0000-7000-8000-0000000000k1",
  code: "PED-1",
  invoice_key: null,
  invoice_number: null,
  recipient_name: "Padaria Central",
  recipient_document: null,
  recipient_email: null,
  recipient_telephone: null,
  cep: "01001000",
  city: "São Paulo",
  uf: "SP",
  street: "Praça da Sé",
  address_number: null,
  complement: null,
  neighborhood: null,
  scheduled_date: new Date("2026-09-24T00:00:00.000Z"),
  notes: null,
  // Stored in the reverse order, at the columns' scales (10,3) and (10,2).
  items: [
    {
      description: "Açúcar",
      quantity: new Prisma.Decimal("2.000"),
      unit: null,
      unit_value: null,
    },
    {
      description: "Farinha",
      quantity: new Prisma.Decimal("1.001"),
      unit: null,
      unit_value: new Prisma.Decimal("10.01"),
    },
  ],
};

describe("a retry of the same body", () => {
  it("matches the row it created, whatever the column scale and item order did", () => {
    expect(isSameSubmission(draftOf(body), stored)).toBe(true);
  });

  it("does not match once any field of the document differs", () => {
    expect(
      isSameSubmission(draftOf({ ...body, city: "Campinas" }), stored),
    ).toBe(false);
    expect(
      isSameSubmission(
        draftOf({ ...body, scheduled_date: "2026-09-25" }),
        stored,
      ),
    ).toBe(false);
    expect(
      isSameSubmission(draftOf({ ...body, notes: "Portão 2" }), stored),
    ).toBe(false);
  });

  it("does not match a different list of items", () => {
    expect(
      isSameSubmission(
        draftOf({ ...body, items: body.items.slice(0, 1) }),
        stored,
      ),
    ).toBe(false);

    expect(
      isSameSubmission(
        draftOf({
          ...body,
          items: [body.items[0], { ...body.items[1], quantity: 3 }],
        }),
        stored,
      ),
    ).toBe(false);
  });

  it("does not match another shipper, nor one that could not be found", () => {
    expect(
      isSameSubmission(
        { ...draftOf(body), shipperId: "018f6000-0000-7000-8000-0000000000f2" },
        stored,
      ),
    ).toBe(false);

    expect(
      isSameSubmission({ ...draftOf(body), shipperId: null }, stored),
    ).toBe(false);
  });
});

describe("the item amounts the create writes", () => {
  // Floats an ERP computes (3 * 1.115, a sum of cents) next to a rounding
  // boundary. The database read the float at 15 digits and kept the upper
  // value; rounding the shortest digits said the lower one, and an identical
  // retry got 409 IDEMPOTENCY_KEY_REUSED.
  const cases: Array<[number, number, number]> = [
    // [value, scale, what the column holds]
    [3 * 1.115, 2, 3.35],
    [1.0004999999999999, 3, 1.001],
    [0.1 + 0.2, 2, 0.3],
    [2.675, 2, 2.68],
    [1.005, 2, 1.01],
    [1234567.125, 2, 1234567.13],
    [1.3333, 3, 1.333],
    [99999999, 2, 99999999],
    [999999, 3, 999999],
  ];

  it("are the decimal the ERP meant, rounded half up to the column's scale", () => {
    for (const [value, scale, expected] of cases) {
      const item: DraftItem =
        scale === 3
          ? itemAtColumnScale({ description: "Item", quantity: value })
          : itemAtColumnScale({
              description: "Item",
              quantity: 1,
              unit_value: value,
            });

      expect(scale === 3 ? item.quantity : item.unit_value, String(value)).toBe(
        expected,
      );
    }
  });

  it("are already at scale, so writing them again changes nothing", () => {
    for (const [value] of cases) {
      const once = itemAtColumnScale({
        description: "Item",
        quantity: value,
        unit_value: value,
      });

      expect(itemAtColumnScale(once), String(value)).toEqual(once);
    }
  });

  it("leave an absent unit value absent and the default quantity alone", () => {
    expect(itemAtColumnScale({ description: "Item", quantity: 1 })).toEqual({
      description: "Item",
      quantity: 1,
    });

    expect(
      itemAtColumnScale({ description: "Item", quantity: 2, unit_value: null }),
    ).toEqual({
      description: "Item",
      quantity: 2,
      unit_value: null,
    });
  });

  it("let an identical retry of such a body match the row it wrote", () => {
    const floats = {
      ...body,
      items: [
        {
          description: "Óleo",
          quantity: 1.0004999999999999,
          unit_value: 3 * 1.115,
        },
      ],
    };

    const row: StoredDelivery = {
      ...stored,
      items: [
        {
          description: "Óleo",
          quantity: new Prisma.Decimal("1.001"),
          unit: null,
          unit_value: new Prisma.Decimal("3.35"),
        },
      ],
    };

    expect(isSameSubmission(draftOf(floats), row)).toBe(true);

    // And the comparison alone, on the raw floats, agrees with the write.
    const {
      shipper_id: _id,
      shipper_cnpj: _cnpj,
      ...raw
    } = parseIntegrationDeliveryBody(floats);

    expect(isSameSubmission({ ...raw, shipperId: SHIPPER }, row)).toBe(true);
  });
});

describe("the Idempotency-Key", () => {
  it("is required", () => {
    expect(() => readIntegrationIdempotencyKey({})).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: "IDEMPOTENCY_KEY_REQUIRED",
      }),
    );

    expect(() =>
      readIntegrationIdempotencyKey({ "idempotency-key": "" }),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REQUIRED" }));
  });

  it("accepts a UUID and a key derived from the ERP's own document", () => {
    const uuid = "0192f7f0-5c1e-7a3b-9d2e-4f6a8b0c1d2e";

    expect(readIntegrationIdempotencyKey({ "idempotency-key": uuid })).toBe(
      uuid,
    );
    expect(
      readIntegrationIdempotencyKey({ "idempotency-key": "pedido-10452" }),
    ).toBe("pedido-10452");
  });

  it("refuses what is too short, too long, spaced or sent twice", () => {
    for (const raw of [
      "curta",
      "x".repeat(129),
      "pedido 10452",
      "a1b2c3d4, a1b2c3d4",
      ["a1b2c3d4", "a1b2c3d4"],
    ]) {
      expect(
        () => readIntegrationIdempotencyKey({ "idempotency-key": raw }),
        String(raw),
      ).toThrow(
        expect.objectContaining({
          statusCode: 400,
          code: "IDEMPOTENCY_KEY_INVALID",
        }),
      );
    }
  });
});

describe("a refused body", () => {
  function issuesOf(raw: unknown): string[] {
    try {
      parseIntegrationDeliveryBody(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);

      return (error as ZodError).issues.map((issue) => issue.message);
    }

    throw new Error("o corpo deveria ter sido recusado");
  }

  it("names the field of every problem, in Portuguese", () => {
    const { recipient_name: _name, ...withoutName } = body;

    const issues = issuesOf({
      ...withoutName,
      cep: "123",
      items: [{ quantity: 1 }],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        "recipient_name: campo obrigatório.",
        "cep: O CEP deve ter exatamente 8 dígitos.",
        "items.0.description: campo obrigatório.",
      ]),
    );

    // zod's own English never reaches an integrator.
    expect(issues.join(" ")).not.toMatch(/Required|Expected/);
  });

  it("says the manual create's sentence for the manual create's rule", () => {
    // The same zod rule, not a copy: the panel and the API refuse alike.
    const manual = createDeliverySchema.safeParse({
      ...body,
      shipperId: SHIPPER,
      uf: "S1",
    });

    expect(manual.success).toBe(false);

    const sentence = manual.success ? "" : manual.error.issues[0].message;

    expect(issuesOf({ ...body, uf: "S1" })).toContain(`uf: ${sentence}`);
  });

  it("refuses a field that does not exist instead of dropping it", () => {
    expect(issuesOf({ ...body, adress_number: "120" })).toContain(
      "corpo: campo não reconhecido: adress_number. Confira os nomes na documentação.",
    );
  });

  it("refuses a field that does not exist inside an item, too", () => {
    // `unitValue` was dropped and the item stored without its price.
    expect(
      issuesOf({
        ...body,
        items: [{ description: "Farinha", quantity: 1, unitValue: 99 }],
      }),
    ).toEqual([
      "items.0: campo não reconhecido: unitValue. Confira os nomes na documentação.",
    ]);
  });

  it("keeps the manual limit of items, with the manual sentence", () => {
    const items = Array.from({ length: 201 }, (_, index) => ({
      description: `Item ${index}`,
    }));

    const manual = createDeliverySchema.safeParse({
      ...body,
      shipperId: SHIPPER,
      items,
    });

    expect(manual.success).toBe(false);

    const sentence = manual.success ? "" : manual.error.issues[0].message;

    expect(sentence).toContain("200");
    expect(issuesOf({ ...body, items })).toEqual([`items: ${sentence}`]);
    expect(() =>
      parseIntegrationDeliveryBody({ ...body, items: items.slice(0, 200) }),
    ).not.toThrow();
  });

  it("wants the shipper by exactly one of id or CNPJ", () => {
    const { shipper_id: _id, ...withoutShipper } = body;

    expect(issuesOf(withoutShipper)).toContain(
      "shipper_id: informe o embarcador por shipper_id ou por shipper_cnpj.",
    );

    expect(issuesOf({ ...body, shipper_cnpj: "12345678000195" })).toContain(
      "shipper_id: informe o embarcador por shipper_id OU por shipper_cnpj, não pelos dois.",
    );

    expect(
      issuesOf({ ...withoutShipper, shipper_cnpj: "12345678000100" }),
    ).toContain("shipper_cnpj: O CNPJ do embarcador não é válido.");
  });

  it("reads an empty shipper field as absent, as the manual create does", () => {
    // An ERP serialises an empty column as "": that is not a second shipper.
    const byId = parseIntegrationDeliveryBody({ ...body, shipper_cnpj: "" });

    expect(byId.shipper_id).toBe(SHIPPER);
    expect(byId.shipper_cnpj ?? null).toBeNull();

    const { shipper_id: _id, ...withoutShipper } = body;

    const byCnpj = parseIntegrationDeliveryBody({
      ...withoutShipper,
      shipper_id: "  ",
      shipper_cnpj: "12345678000195",
    });

    expect(byCnpj.shipper_id ?? null).toBeNull();
    expect(byCnpj.shipper_cnpj).toBe("12345678000195");

    // Both empty is no shipper at all; letters are still not a CNPJ.
    expect(
      issuesOf({ ...withoutShipper, shipper_id: "", shipper_cnpj: "" }),
    ).toEqual([
      "shipper_id: informe o embarcador por shipper_id ou por shipper_cnpj.",
    ]);

    expect(issuesOf({ ...withoutShipper, shipper_cnpj: "abc" })).toContain(
      "shipper_cnpj: O CNPJ do embarcador deve ter 14 dígitos.",
    );
  });

  it("takes a masked CNPJ and a null list of items", () => {
    const { shipper_id: _id, ...withoutShipper } = body;

    const parsed = parseIntegrationDeliveryBody({
      ...withoutShipper,
      shipper_cnpj: "12.345.678/0001-95",
      items: null,
    });

    expect(parsed.shipper_cnpj).toBe("12345678000195");
    expect(parsed.items).toBeUndefined();
  });

  it("says so when there is no body at all", () => {
    expect(issuesOf(undefined)).toEqual([
      "corpo: envie um objeto JSON com os campos da entrega.",
    ]);
  });
});
