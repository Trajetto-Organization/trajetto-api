import { describe, expect, it } from "vitest";

import { updateShipperSchema } from "@/schemas/update-shipper-schema";
import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";
import { createDeliverySchema } from "@/schemas/create-delivery-schema";

/**
 * Clearing an optional field has to reach the database.
 *
 * The deliveries schemas normalised an emptied input to `undefined`, and
 * JSON.stringify drops undefined keys — so the PATCH body simply had no
 * `cnpj` in it and the old value survived. Every repository filters only
 * `undefined`, which makes `null` the value that actually clears a column.
 */
describe("clearing optional fields in the deliveries module", () => {
  it("accepts a shipper body with cleared fields and keeps them null", () => {
    const parsed = updateShipperSchema.safeParse({
      name: "Embarcador Teste",
      cnpj: null,
      email: null,
      telephone: null,
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      // null, not undefined: undefined would be filtered out by the
      // repository and the column would keep its old value.
      expect(parsed.data.cnpj).toBeNull();
      expect(parsed.data.email).toBeNull();
      expect(parsed.data.telephone).toBeNull();
    }
  });

  it("still normalises a filled shipper field to digits", () => {
    const parsed = updateShipperSchema.safeParse({
      cnpj: "12.345.678/0001-95",
      telephone: "(11) 98888-7777",
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.cnpj).toBe("12345678000195");
      expect(parsed.data.telephone).toBe("11988887777");
    }
  });

  it("still refuses an invalid value rather than clearing it", () => {
    const parsed = updateShipperSchema.safeParse({ email: "nao-e-email" });
    expect(parsed.success).toBe(false);
  });

  it("clears an occurrence type description", () => {
    const parsed = updateOccurrenceTypeSchema.safeParse({
      name: "Avaria",
      description: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.description).toBeNull();
  });

  it("accepts a delivery with every optional field blank", () => {
    // The create form submits empty strings for what the user left alone, so
    // every optional field has to survive the round trip as null. A partial
    // conversion here is what made the form answer "Validation Error" while
    // pointing at nothing in particular.
    const parsed = createDeliverySchema.safeParse({
      businessId: "01a0-business",
      shipperId: "01a0-shipper",
      recipient_name: "Cliente Teste",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Teste",
      // Required: the delivery address is what the route is built from, so
      // manual entry demands a CEP the same way every other address form does.
      cep: "12345678",
      code: "",
      invoice_key: "",
      invoice_number: "",
      recipient_document: "",
      recipient_email: "",
      recipient_telephone: "",
      address_number: "",
      complement: "",
      neighborhood: "",
      scheduled_date: "",
      notes: "",
      vehicleId: "",
      driverId: "",
    });

    // Asserting on the error map instead of the boolean: a failure names the
    // offending field instead of just saying "false".
    expect(parsed.success ? {} : parsed.error.flatten().fieldErrors).toEqual(
      {},
    );

    if (parsed.success) {
      for (const field of [
        "recipient_document",
        "recipient_telephone",
        "scheduled_date",
        "notes",
      ] as const) {
        expect(parsed.data[field]).toBeNull();
      }

      // The CEP is not optional, so it survives as the value that was sent.
      expect(parsed.data.cep).toBe("12345678");
    }
  });

  it("still refuses a malformed optional value in a delivery", () => {
    // Nullable must not become "anything goes": a CEP with 3 digits is an
    // error, and now so is an empty one — the address is required.
    const parsed = createDeliverySchema.safeParse({
      businessId: "01a0-business",
      shipperId: "01a0-shipper",
      recipient_name: "Cliente Teste",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Teste",
      cep: "123",
    });

    expect(parsed.success).toBe(false);
  });

  it("leaves an untouched field absent so the update ignores it", () => {
    // Absent is not the same as cleared: a PATCH that omits a field must not
    // wipe it, which is exactly why undefined and null had to stop being
    // interchangeable here.
    const parsed = updateShipperSchema.safeParse({ name: "Só o nome" });

    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect("cnpj" in parsed.data && parsed.data.cnpj !== undefined).toBe(
        false,
      );
  });
});
