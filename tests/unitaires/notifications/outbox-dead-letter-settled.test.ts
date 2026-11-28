import { describe, expect, it } from "vitest";

import { settledDeliveriesOf } from "@/shared/notifications/outbox-dead-letter";

/**
 * What the replay of an archived event gives back to the new one
 * (plano-escala F5-10): the deliveries the original already settled, as
 * the purge recorded them in settled_deliveries.
 *
 * The replay creates those rows before the expansion runs, so a row it
 * misreads is either a message sent twice (a delivery dropped) or a row
 * the database refuses (two recipients, an unknown channel), which fails
 * the whole replay. So only an entry that is exactly one settled delivery
 * comes back; anything else is left to the expansion, as before.
 */
const delivery = {
  userId: "019a9a80-0000-7000-8000-000000000c02",
  externalRecipientId: null,
  channel: "WHATSAPP",
  status: "DELIVERED",
  attempts: 1,
  deliveredAt: 1_790_000_000_000,
  lastError: null,
  providerMessageId: "wamid.original",
  providerStatus: "read",
  providerStatusAt: 1_790_000_060_000,
};

describe("settledDeliveriesOf", () => {
  it("reads every settled delivery the purge recorded, times as epoch ms", () => {
    expect(
      settledDeliveriesOf([
        delivery,
        {
          ...delivery,
          userId: null,
          externalRecipientId: "019a9a80-0000-7000-8000-000000000c09",
          channel: "EMAIL",
          status: "FAILED",
          attempts: 5,
          deliveredAt: null,
          lastError: "caixa cheia",
          providerStatus: null,
          providerStatusAt: null,
        },
      ]),
    ).toEqual([
      delivery,
      {
        userId: null,
        externalRecipientId: "019a9a80-0000-7000-8000-000000000c09",
        channel: "EMAIL",
        status: "FAILED",
        attempts: 5,
        deliveredAt: null,
        lastError: "caixa cheia",
        providerMessageId: "wamid.original",
        providerStatus: null,
        providerStatusAt: null,
      },
    ]);
  });

  it("is empty for a copy with none (NULL) or a value that is not a list", () => {
    expect(settledDeliveriesOf(null)).toEqual([]);
    expect(settledDeliveriesOf({ delivery })).toEqual([]);
    expect(settledDeliveriesOf("[]")).toEqual([]);
  });

  it("leaves out an entry that is not exactly one settled delivery", () => {
    expect(
      settledDeliveriesOf([
        {
          ...delivery,
          externalRecipientId: "019a9a80-0000-7000-8000-0000000c0a",
        },
        { ...delivery, userId: null },
        { ...delivery, channel: "SMS" },
        { ...delivery, status: "PENDING" },
        { ...delivery, status: "PROCESSING" },
        null,
        [delivery],
        "texto",
      ]),
    ).toEqual([]);
  });
});
