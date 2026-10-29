import { describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";

import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

/**
 * The in-memory createDelivery behaves like the table (decision 13.2).
 *
 * Postgres has a unique (businessId, client_submission_id) index: the same
 * Idempotency-Key is one delivery, and the panel's and the integration's race
 * branches depend on the second insert failing. The twin enforced only the
 * NF-e key, so a second create with the same key succeeded in memory.
 */
const base = (
  overrides: Partial<CreateDeliveryProps> = {},
): CreateDeliveryProps => ({
  recipient_name: "Destinatário",
  city: "São Paulo",
  uf: "SP",
  street: "Rua das Entregas",
  businessId: "b1",
  shipperId: "s1",
  ...overrides,
});

describe("the in-memory createDelivery", () => {
  it("refuses a second delivery with the same submission key in the company, like the unique index", async () => {
    const repository = new InMemoryDeliveryRepository();

    await repository.createDelivery(base({ client_submission_id: "key-1" }));

    const second = repository.createDelivery(
      base({ client_submission_id: "key-1" }),
    );

    await expect(second).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    await expect(second).rejects.toMatchObject({
      code: "P2002",
      meta: { target: ["businessId", "client_submission_id"] },
    });

    // Nothing was written by the refused insert.
    expect(repository.deliveries).toHaveLength(1);
  });

  it("accepts the same key in another company, and deliveries without a key", async () => {
    const repository = new InMemoryDeliveryRepository();

    await repository.createDelivery(base({ client_submission_id: "key-1" }));
    await repository.createDelivery(
      base({ businessId: "b2", client_submission_id: "key-1" }),
    );
    await repository.createDelivery(base());
    await repository.createDelivery(base());

    expect(repository.deliveries).toHaveLength(4);
  });

  it("keeps the API key that created it (the origin INTEGRATION)", async () => {
    const repository = new InMemoryDeliveryRepository();

    const byKey = await repository.createDelivery(
      base({ apiKeyId: "api-key-1" }),
    );
    const byPanel = await repository.createDelivery(base());

    expect(byKey.apiKeyId).toBe("api-key-1");
    expect(byPanel.apiKeyId).toBeNull();
  });
});
