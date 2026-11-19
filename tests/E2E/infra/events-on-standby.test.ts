// @vitest-environment node
import type { PrismaClient } from "@prisma/client";
import pg from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import { parseEventCursor } from "@/modules/integration/cursor";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { logger } from "@/shared/logging/logger";

import { infraUrl } from "./support/infra-urls";

/**
 * /integration/v1/events on the real standby of the infra phase
 * (plano-escala F4-43; tests/E2E/infra/run.sh).
 *
 * With INTEGRATION_EVENTS_READ_REPLICA, the commit walk reads its pages on
 * the standby, the horizon being the standby's own pg_current_snapshot():
 * everything below its xmin has been replayed there. The guard may move a
 * poller between the standby and the primary at any page, so the reader
 * here does that at random while four writers commit 2 000 events on the
 * primary in transactions of one to four, with pauses inside, out of txid
 * order. The gate of the plan: none skipped, none twice, the cursor only
 * moving forward.
 */
const EVENTS = 2_000;
const WRITERS = 4;
const INSERT = `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId") VALUES ($1, 'NOTE', $2, $3, $4)`;

let primary: PrismaClient;
let standby: PrismaClient;
const sessions: pg.Client[] = [];
const original = {
  order: env.INTEGRATION_FEED_ORDER,
  replica: env.INTEGRATION_EVENTS_READ_REPLICA,
};

let carrier: string;
let deliveryId: string;

async function session(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: infraUrl("primary"),
    application_name: "events-on-standby-e2e",
  });

  await client.connect();
  sessions.push(client);

  return client;
}

/** A company with one delivery, on the primary; its id and the delivery's. */
async function company(): Promise<[string, string]> {
  const id = uuidV7();
  const shipperId = uuidV7();
  const cnpj = String(Date.now()).slice(-8).padStart(8, "0") + "000191";

  await primary.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${cnpj}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `feed-standby-${id}@example.com`,
    },
  });
  await primary.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
  await primary.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId: id },
  });

  const delivery = await primary.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: id,
      shipperId,
    },
  });

  return [id, delivery.id];
}

/** Until the standby replayed everything the primary has written. */
async function caughtUp(): Promise<void> {
  const [{ lsn }] = await primary.$queryRawUnsafe<Array<{ lsn: string }>>(
    "SELECT pg_current_wal_lsn()::text AS lsn",
  );

  await vi.waitFor(
    async () => {
      const [row] = await standby.$queryRawUnsafe<Array<{ done: boolean }>>(
        `SELECT pg_last_wal_replay_lsn() >= '${lsn}'::pg_lsn AS done`,
      );

      expect(row.done).toBe(true);
    },
    { timeout: 30_000, interval: 100 },
  );
}

beforeAll(async () => {
  primary = createPrismaClient({}, { url: infraUrl("primary") });
  standby = createPrismaClient({}, { url: infraUrl("standby") });
  [carrier, deliveryId] = await company();
  env.INTEGRATION_FEED_ORDER = "commit";
  env.INTEGRATION_EVENTS_READ_REPLICA = true;
}, 60_000);

afterAll(async () => {
  env.INTEGRATION_FEED_ORDER = original.order;
  env.INTEGRATION_EVENTS_READ_REPLICA = original.replica;

  for (const client of sessions) await client.end().catch(() => undefined);
  await standby.$disconnect();
  await primary.$disconnect();
});

describe("the events feed on the standby", () => {
  it("serves its pages there, with the standby's own horizon", async () => {
    const standbyServed = vi.fn(() => standby);
    const repository = new IntegrationRepository(primary, standbyServed);
    const warn = vi.spyOn(logger, "warn");
    const writer = await session();
    const held = uuidV7();
    const later = uuidV7();

    try {
      // An event whose transaction is still open on the primary, then one
      // committed after it: neither may be served while the first is open.
      await writer.query("BEGIN");
      await writer.query(INSERT, [held, "held", deliveryId, carrier]);

      const other = await session();

      await other.query(INSERT, [later, "later", deliveryId, carrier]);
      await caughtUp();

      const open = await repository.listEvents({
        businessId: carrier,
        limit: 100,
      });

      expect(open.data.map((event) => event.id)).not.toContain(later);
      expect(open.data.map((event) => event.id)).not.toContain(held);

      await writer.query("COMMIT");
      await caughtUp();

      const closed = await repository.listEvents({
        businessId: carrier,
        limit: 100,
        position: open.resume_cursor
          ? parseEventCursor(open.resume_cursor)
          : undefined,
      });

      expect(closed.data.map((event) => event.id)).toEqual([held, later]);
      expect(standbyServed).toHaveBeenCalled();
      // Served by the standby, not by the primary after a failure.
      expect(
        warn.mock.calls.filter(([, message]) =>
          String(message).includes("the standby failed the page"),
        ),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
      await writer.query("ROLLBACK").catch(() => undefined);
    }
  }, 60_000);

  it("skips none and repeats none of 2 000 interleaved events, moving between the standby and the primary", async () => {
    const onStandby = new IntegrationRepository(primary, () => standby);
    const onPrimary = new IntegrationRepository(primary, () => null);
    const warn = vi.spyOn(logger, "warn");

    // Where the reader starts: past everything written so far.
    let cursor: string | null = null;

    for (;;) {
      const result = await onPrimary.listEvents({
        businessId: carrier,
        limit: 500,
        position: cursor ? parseEventCursor(cursor) : undefined,
      });

      cursor = result.resume_cursor ?? cursor;
      if (!result.next_cursor) break;
    }

    const written = new Set<string>();
    let remaining = EVENTS;
    let writing = WRITERS;
    const writers = await Promise.all(
      Array.from({ length: WRITERS }, () => session()),
    );

    const write = async (client: pg.Client) => {
      try {
        while (remaining > 0) {
          const size = Math.min(remaining, 1 + Math.floor(Math.random() * 4));

          remaining -= size;
          await client.query("BEGIN");

          const ids: string[] = [];

          for (let i = 0; i < size; i += 1) {
            const id = uuidV7();

            ids.push(id);
            await client.query(INSERT, [id, "stress", deliveryId, carrier]);
            if (Math.random() < 0.3) {
              await client.query("SELECT pg_sleep($1)", [
                Math.random() * 0.004,
              ]);
            }
          }

          await client.query("COMMIT");
          for (const id of ids) written.add(id);
        }
      } finally {
        writing -= 1;
      }
    };

    const read: string[] = [];
    const txids: bigint[] = [];
    let standbyPages = 0;
    let primaryPages = 0;

    const page = async (fromStandby: boolean) => {
      const result = await (fromStandby ? onStandby : onPrimary).listEvents({
        businessId: carrier,
        limit: 50,
        position: cursor ? parseEventCursor(cursor) : undefined,
      });

      if (fromStandby) standbyPages += 1;
      else primaryPages += 1;

      for (const event of result.data) {
        if (event.data.note === "stress") read.push(event.id);
      }

      if (result.resume_cursor) {
        cursor = result.resume_cursor;
        txids.push(parseEventCursor(cursor).txid);
      }

      return result;
    };

    const reader = async () => {
      while (writing > 0) await page(Math.random() < 0.7);
    };

    await Promise.all([...writers.map(write), reader()]);

    // The last pass, on the standby, once it replayed every commit.
    await caughtUp();
    for (;;) {
      const result = await page(true);

      if (!result.next_cursor) break;
    }

    expect(written.size).toBe(EVENTS);
    expect(read.length).toBe(EVENTS);
    expect(new Set(read)).toEqual(written);

    for (let i = 1; i < txids.length; i += 1) {
      expect(txids[i] >= txids[i - 1], `cursor ${i}`).toBe(true);
    }

    // Both servers served pages, and the standby never fell back.
    expect(standbyPages).toBeGreaterThan(10);
    expect(primaryPages).toBeGreaterThan(0);
    expect(
      warn.mock.calls.filter(([, message]) =>
        String(message).includes("the standby failed the page"),
      ),
    ).toEqual([]);
    warn.mockRestore();
  }, 180_000);

  it("keeps the feed on the primary without the flag, whatever the standby says", async () => {
    const standbyServed = vi.fn(() => standby);
    const repository = new IntegrationRepository(primary, standbyServed);

    env.INTEGRATION_EVENTS_READ_REPLICA = false;

    try {
      await repository.listEvents({ businessId: carrier, limit: 1 });
      expect(standbyServed).not.toHaveBeenCalled();
    } finally {
      env.INTEGRATION_EVENTS_READ_REPLICA = true;
    }
  });
});
