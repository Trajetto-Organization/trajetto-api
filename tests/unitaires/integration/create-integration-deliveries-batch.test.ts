import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { AppError } from "@/shared/errors/AppError";
import {
  MAX_BATCH_DELIVERIES,
  parseBatchEnvelope,
} from "@/schemas/create-integration-deliveries-batch-schema";
import { CreateIntegrationDeliveriesBatchUseCase } from "@/modules/integration/usecases/create-integration-deliveries-batch/create-integration-deliveries-batch-usecase";
import { IdempotencyKeyReusedError } from "@/modules/integration/usecases/create-delivery/create-integration-delivery-errors";
import type { CreateIntegrationDeliveryUseCase } from "@/modules/integration/usecases/create-delivery/create-integration-delivery-usecase";

/**
 * The batch of the public create (plano-escala U-04, F4.5), around a stand
 * in for the single create: the envelope refuses the whole call, each
 * element is the single create's own run, and a refusal is that element's
 * result at its position while the others go on. The SQL, the replay and
 * the limits are tests/E2E/integration-deliveries-batch.test.ts.
 */

const KEY_A = "pedido-0000001";
const KEY_B = "pedido-0000002";

function element(key: string | undefined, overrides: object = {}) {
  return {
    ...(key !== undefined && { idempotency_key: key }),
    shipper_id: "018f6200-0000-7000-8000-0000000000f1",
    recipient_name: "Mercado Bom Preço Ltda",
    cep: "13010000",
    street: "Rua das Flores",
    city: "Campinas",
    uf: "SP",
    ...overrides,
  };
}

function useCase(execute: CreateIntegrationDeliveryUseCase["execute"]) {
  const create = { execute: vi.fn(execute) };

  return {
    create,
    batch: new CreateIntegrationDeliveriesBatchUseCase(
      create as unknown as CreateIntegrationDeliveryUseCase,
    ),
  };
}

const input = (deliveries: unknown[]) => ({
  businessId: "b-1",
  apiKeyId: "k-1",
  apiKeyName: "ERP",
  deliveries,
});

describe("the envelope", () => {
  it(`takes 1 to ${MAX_BATCH_DELIVERIES} deliveries, and refuses the call otherwise`, () => {
    expect(parseBatchEnvelope({ deliveries: [{}] }).deliveries).toHaveLength(1);
    expect(
      parseBatchEnvelope({
        deliveries: Array.from({ length: MAX_BATCH_DELIVERIES }, () => ({})),
      }).deliveries,
    ).toHaveLength(MAX_BATCH_DELIVERIES);

    for (const body of [
      {
        deliveries: Array.from(
          { length: MAX_BATCH_DELIVERIES + 1 },
          () => ({}),
        ),
      },
      { deliveries: [] },
      { deliveries: "x" },
      {},
      null,
      { deliveries: [{}], businessId: "outra" },
    ]) {
      expect(() => parseBatchEnvelope(body), JSON.stringify(body)).toThrow(
        ZodError,
      );
    }
  });

  it("names the ceiling in its sentence", () => {
    try {
      parseBatchEnvelope({
        deliveries: Array.from(
          { length: MAX_BATCH_DELIVERIES + 1 },
          () => ({}),
        ),
      });
    } catch (error) {
      expect((error as ZodError).issues[0].message).toContain(
        `no máximo ${MAX_BATCH_DELIVERIES} entregas`,
      );
    }
  });
});

describe("each delivery", () => {
  it("runs the single create, in order, with its own key and the key's company", async () => {
    const { batch, create } = useCase(async ({ idempotencyKey }) => ({
      replayed: idempotencyKey === KEY_B,
      delivery: { id: `d-${idempotencyKey}` } as never,
    }));

    const results = await batch.execute(
      input([element(KEY_A), element(KEY_B)]),
    );

    expect(results).toEqual([
      {
        index: 0,
        idempotency_key: KEY_A,
        status: 201,
        delivery_id: `d-${KEY_A}`,
      },
      {
        index: 1,
        idempotency_key: KEY_B,
        status: 200,
        delivery_id: `d-${KEY_B}`,
      },
    ]);

    expect(
      create.execute.mock.calls.map(([call]) => call.idempotencyKey),
    ).toEqual([KEY_A, KEY_B]);

    // The company is the key's, and the element's key never reaches the
    // single create's body (its parser would refuse the unknown field).
    for (const [call] of create.execute.mock.calls) {
      expect(call.businessId).toBe("b-1");
      expect(call.body).not.toHaveProperty("idempotency_key");
    }
  });

  it("is its own result when refused, and the others still go", async () => {
    const { batch, create } = useCase(async ({ idempotencyKey }) => {
      if (idempotencyKey === KEY_A) {
        throw new IdempotencyKeyReusedError("d-existing");
      }

      if (idempotencyKey === "pedido-0000003") {
        throw new AppError(
          "Embarcador não encontrado.",
          404,
          "SHIPPER_NOT_FOUND",
        );
      }

      return { replayed: false, delivery: { id: "d-new" } as never };
    });

    const results = await batch.execute(
      input([
        element(KEY_A),
        element(undefined),
        element("curta"),
        element(KEY_B, { cep: "123" }),
        "não é um objeto",
        element("pedido-0000003"),
        element("pedido-0000004"),
      ]),
    );

    expect(results.map((result) => [result.status, result.code])).toEqual([
      [409, "IDEMPOTENCY_KEY_REUSED"],
      [400, "IDEMPOTENCY_KEY_REQUIRED"],
      [400, "IDEMPOTENCY_KEY_INVALID"],
      [400, "VALIDATION_ERROR"],
      [400, "VALIDATION_ERROR"],
      [404, "SHIPPER_NOT_FOUND"],
      [201, undefined],
    ]);

    // The 409 names the delivery in the way, as the single create's does.
    expect(results[0].delivery_id).toBe("d-existing");
    // A refused value is not echoed back.
    expect(results[2].idempotency_key).toBeNull();
    expect(results[3].issues?.[0]).toMatch(/^cep: /);

    // Only the elements that passed the parse reached the single create.
    expect(create.execute).toHaveBeenCalledTimes(3);
  });

  it("stops the batch on a failure that is not the delivery's", async () => {
    const { batch, create } = useCase(async ({ idempotencyKey }) => {
      if (idempotencyKey === KEY_B) throw new Error("connection terminated");

      return { replayed: false, delivery: { id: "d-1" } as never };
    });

    await expect(
      batch.execute(
        input([element(KEY_A), element(KEY_B), element("pedido-0000009")]),
      ),
    ).rejects.toThrow("connection terminated");

    // The retry of the whole batch replays the first; nothing ran after.
    expect(create.execute).toHaveBeenCalledTimes(2);
  });
});
