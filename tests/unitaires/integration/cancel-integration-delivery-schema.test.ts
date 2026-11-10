import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseCancelIntegrationDeliveryBody } from "@/schemas/cancel-integration-delivery-schema";

/**
 * The body of POST /integration/v1/deliveries/:id/cancel (L9): the reason is
 * required, with the panel annotation's text rules, and every refusal names
 * its field — an ERP's log has no red field to point at.
 */
function issuesOf(body: unknown): string[] {
  try {
    parseCancelIntegrationDeliveryBody(body);
  } catch (error) {
    if (error instanceof ZodError) return error.issues.map((i) => i.message);

    throw error;
  }

  return [];
}

describe("the cancel's body", () => {
  it("takes a reason, line breaks included", () => {
    expect(
      parseCancelIntegrationDeliveryBody({
        reason: "Pedido cancelado pelo cliente no ERP.",
      }),
    ).toEqual({ reason: "Pedido cancelado pelo cliente no ERP." });

    expect(
      issuesOf({ reason: "Pedido cancelado.\n\nCliente desistiu da compra." }),
    ).toEqual([]);
  });

  it("refuses a missing reason, or one that is not a text, naming the field", () => {
    for (const body of [{}, { reason: null }, { reason: 42 }]) {
      expect(issuesOf(body), JSON.stringify(body)).toEqual([
        "reason: informe o motivo do cancelamento, em texto.",
      ]);
    }
  });

  it("refuses a body that is not an object", () => {
    for (const body of [undefined, null, "cancelar", [1]]) {
      expect(issuesOf(body), String(body)).toEqual([
        "corpo: envie um objeto JSON com o campo reason.",
      ]);
    }
  });

  it("bounds its length", () => {
    expect(issuesOf({ reason: "" })).toEqual([
      "reason: O motivo deve ter no mínimo 3 caracteres.",
    ]);
    expect(issuesOf({ reason: "ok" })).toEqual([
      "reason: O motivo deve ter no mínimo 3 caracteres.",
    ]);
    expect(issuesOf({ reason: "a".repeat(500) })).toEqual([]);
    expect(issuesOf({ reason: "a".repeat(501) })).toEqual([
      "reason: O motivo deve ter no máximo 500 caracteres.",
    ]);
  });

  it("refuses blank text, repeated spaces and spaces at the ends", () => {
    expect(issuesOf({ reason: "     " })).toEqual([
      "reason: O motivo não pode conter apenas espaços.",
    ]);
    expect(issuesOf({ reason: "Pedido  cancelado" })).toEqual([
      "reason: O motivo não deve conter espaços consecutivos.",
    ]);
    expect(issuesOf({ reason: " Pedido cancelado" })).toEqual([
      "reason: O motivo não pode começar ou terminar com espaço em branco.",
    ]);
    expect(issuesOf({ reason: "Pedido cancelado \nno ERP" })).toEqual([
      "reason: O motivo não pode começar ou terminar com espaço em branco.",
    ]);
  });

  it("refuses an unknown field, in Portuguese and by name", () => {
    expect(issuesOf({ reason: "Pedido cancelado.", motivo: "x" })).toEqual([
      "corpo: campo não reconhecido: motivo. Confira os nomes na documentação.",
    ]);
  });
});
