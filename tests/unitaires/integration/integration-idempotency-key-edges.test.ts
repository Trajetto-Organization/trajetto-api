import { describe, expect, it } from "vitest";

import { readIntegrationIdempotencyKey } from "@/modules/integration/usecases/create-delivery/integration-idempotency-key";

/**
 * The public API's Idempotency-Key, edges left alive by the 06/10 mutation
 * run: the length bounds, characters around a valid key, a repeated header,
 * and the exact messages an integrator reads.
 */

const refusal = (headers: Record<string, unknown>) => {
  try {
    readIntegrationIdempotencyKey(headers);
  } catch (error) {
    return {
      message: (error as Error).message,
      code: (error as { code?: string }).code,
    };
  }
  return null;
};

const INVALID = {
  message:
    "Idempotency-Key inválida: use de 8 a 128 caracteres entre letras, números e . _ : - (um UUID serve).",
  code: "IDEMPOTENCY_KEY_INVALID",
};

describe("readIntegrationIdempotencyKey", () => {
  it("accepts 8 to 128 allowed characters", () => {
    expect(
      readIntegrationIdempotencyKey({ "idempotency-key": "pedido-1" }),
    ).toBe("pedido-1");
    expect(
      readIntegrationIdempotencyKey({ "idempotency-key": "a".repeat(128) }),
    ).toBe("a".repeat(128));
  });

  it("refuses a key too short, too long, or with anything around it", () => {
    for (const key of [
      "pedido1",
      "a".repeat(129),
      " pedido-10",
      "pedido-10 ",
      "pedido 10",
    ]) {
      expect(refusal({ "idempotency-key": key })).toEqual(INVALID);
    }
  });

  it("refuses a repeated header", () => {
    expect(refusal({ "idempotency-key": ["pedido-10", "pedido-10"] })).toEqual(
      INVALID,
    );
    // One element still is not a string: it would print as a valid key.
    expect(refusal({ "idempotency-key": ["pedido-10"] })).toEqual(INVALID);
  });

  it("asks for the header when it is missing", () => {
    expect(refusal({})).toEqual({
      message:
        "Envie o cabeçalho Idempotency-Key: um valor único por entrega, repetido em cada nova tentativa do mesmo envio.",
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  });
});
