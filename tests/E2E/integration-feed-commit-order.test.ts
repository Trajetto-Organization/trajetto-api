import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import pg from "pg";
import { v7 as uuidV7 } from "uuid";

import { env } from "@/env";
import { parseEventCursor } from "@/modules/integration/cursor";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { takeFeedCounts } from "@/shared/integration/feed-metrics";

/**
 * The integration feed in commit order (plano-escala F2-05), against a
 * real Postgres with writers that interleave.
 *
 * The id walk skipped an event for good when its transaction minted the id
 * first and committed last: a poller that read a later id in between had
 * already moved past it. The commit walk serves only below the oldest
 * transaction still open, by (txid, id), so a late commit always lands
 * after the cursor. This file shows both: the skip on the id walk, the
 * same race with nothing skipped, and 10 000 events from eight writers in
 * random transactions read while they are written, with none skipped.
 *
 * Runs in the one-file-at-a-time phase (SERIAL_E2E_FILES): the snapshot's
 * xmin belongs to the whole cluster, so an open transaction in another
 * file's database would hold this feed back, and this file's open
 * transactions would hold theirs.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f5c00-0000-7000-8000-00000000000a";
const OTHER = "018f5c00-0000-7000-8000-00000000000b";
const SHIPPER = "018f5c00-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f5c00-0000-7000-8000-0000000000f2";

let deliveryId: string;
let otherDeliveryId: string;
let token: string;

const sessions: pg.Client[] = [];

async function session(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
    application_name: "feed-commit-order-e2e",
  });

  await client.connect();
  sessions.push(client);

  return client;
}

async function company(id: string, shipperId: string, cnpj: string) {
  await prisma.business.create({
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
      email: `feed-${randomUUID()}@example.com`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId: id },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: id,
      shipperId,
    },
  });

  return delivery.id;
}

beforeAll(async () => {
  deliveryId = await company(CARRIER, SHIPPER, "11222999000183");
  otherDeliveryId = await company(OTHER, OTHER_SHIPPER, "11222999000184");

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração do feed por commit",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["events:read"],
      businessId: CARRIER,
    },
  });

  token = key.token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  env.INTEGRATION_FEED_ORDER = "id";

  for (const client of sessions) await client.end().catch(() => undefined);
  await app?.close();
  await prisma.$disconnect();
});

const INSERT = `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId") VALUES ($1, 'NOTE', $2, $3, $4)`;

/** Every event of the carrier's history, by HTTP, from `cursor` on. */
async function page(cursor?: string, limit = 200) {
  const query = new URLSearchParams({ limit: String(limit) });

  if (cursor) query.set("cursor", cursor);

  const response = await app.inject({
    method: "GET",
    url: `/integration/v1/events?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.json() as {
    data: Array<{ id: string; data: { note: string | null } }>;
    next_cursor: string | null;
    resume_cursor: string | null;
  };
}

/** Every page from `cursor` until the last; the notes and where to resume. */
async function drain(cursor?: string) {
  const notes: string[] = [];
  let next = cursor;
  let resume: string | null = cursor ?? null;

  for (;;) {
    const result = await page(next);

    notes.push(...result.data.map((event) => event.data.note ?? ""));
    resume = result.resume_cursor ?? resume;

    if (!result.next_cursor) break;
    next = result.next_cursor;
  }

  return { notes, resume };
}

describe("a transaction that minted its event first and committed last", () => {
  it("is skipped for good by the id walk", async () => {
    env.INTEGRATION_FEED_ORDER = "id";

    const start = await drain();
    const slow = await session();
    const fast = await session();

    // The slow writer mints its id first, then waits; the fast one writes
    // a later id and commits.
    await slow.query("BEGIN");
    await slow.query(INSERT, [uuidV7(), "id-slow", deliveryId, CARRIER]);
    await fast.query(INSERT, [uuidV7(), "id-fast", deliveryId, CARRIER]);

    const during = await drain(start.resume ?? undefined);

    await slow.query("COMMIT");

    const after = await drain(during.resume ?? undefined);

    expect(during.notes).toEqual(["id-fast"]);
    // The cursor already passed the slow event's id: gone for this poller.
    expect(after.notes).toEqual([]);
  });

  it("is waited for, and then served, by the commit walk", async () => {
    env.INTEGRATION_FEED_ORDER = "commit";

    const start = await drain();

    // The id walk's leftovers, then the cursor in v2.
    expect(start.notes).toEqual(expect.arrayContaining(["id-slow", "id-fast"]));
    expect(start.resume).toMatch(/^v2\./);

    const slow = await session();
    const fast = await session();

    await slow.query("BEGIN");
    await slow.query(INSERT, [uuidV7(), "commit-slow", deliveryId, CARRIER]);
    await fast.query(INSERT, [uuidV7(), "commit-fast", deliveryId, CARRIER]);

    // The slow transaction is the xmin: nothing at or after it is served,
    // not even the fast one, which already committed.
    const during = await drain(start.resume!);

    expect(during.notes).toEqual([]);
    expect(during.resume).toBe(start.resume);

    await slow.query("COMMIT");

    const after = await vi.waitFor(
      async () => {
        const result = await drain(during.resume!);

        expect(result.notes).toEqual(["commit-slow", "commit-fast"]);

        return result;
      },
      { timeout: 45_000, interval: 200 },
    );

    expect(after.resume).toMatch(/^v2\./);
    expect((await drain(after.resume!)).notes).toEqual([]);
  }, 60_000);
});

describe("the cursors of the commit walk", () => {
  beforeAll(() => {
    env.INTEGRATION_FEED_ORDER = "commit";
  });

  it("hand out next_cursor between pages and resume_cursor on the last", async () => {
    for (let i = 0; i < 5; i += 1) {
      await prisma.deliveryEvent.create({
        data: {
          type: "NOTE",
          note: `paged-${i}`,
          deliveryId,
          businessId: CARRIER,
        },
      });
    }

    const head = await drain();
    const all: string[] = [];
    let cursor: string | undefined;

    // Two at a time: every page but the last carries next_cursor, and its
    // resume_cursor is the same position.
    for (;;) {
      const result = await page(cursor, 2);

      all.push(...result.data.map((event) => event.data.note ?? ""));

      if (!result.next_cursor) {
        expect(result.resume_cursor).toMatch(/^v2\./);
        break;
      }

      expect(result.resume_cursor).toBe(result.next_cursor);
      cursor = result.next_cursor;
    }

    expect(all).toEqual(head.notes);
    expect(all.slice(-5)).toEqual([0, 1, 2, 3, 4].map((i) => `paged-${i}`));
  });

  it("convert a legacy cursor at least once, never skipping", async () => {
    takeFeedCounts();

    const events = await prisma.deliveryEvent.findMany({
      where: { businessId: CARRIER },
      orderBy: { id: "asc" },
      select: { id: true, note: true },
    });
    const middle = events[Math.floor(events.length / 2)];
    const after = events.filter((event) => event.id > middle.id);

    const { notes, resume } = await drain(middle.id);

    // Every event above the legacy cursor, maybe some below it again.
    expect(notes).toEqual(
      expect.arrayContaining(after.map((event) => event.note)),
    );
    expect(resume).toMatch(/^v2\./);
    expect(takeFeedCounts().legacy_conversions).toBeGreaterThan(0);
  });

  it("never serve another company's events", async () => {
    await prisma.deliveryEvent.create({
      data: {
        type: "NOTE",
        note: "other-company",
        deliveryId: otherDeliveryId,
        businessId: OTHER,
      },
    });

    expect((await drain()).notes).not.toContain("other-company");
  });

  it("carry the epoch, the txid and the floor of the last event served", async () => {
    const { resume } = await drain();
    const position = parseEventCursor(resume!);
    const [epoch] = await prisma.$queryRaw<Array<{ epoch: number }>>`
      SELECT "epoch" FROM "cluster_epoch" WHERE "id" = 1
    `;

    expect(position.format).toBe("v2");
    expect(position.epoch).toBe(epoch.epoch);
    expect(position.txid).toBeGreaterThan(0n);
    expect(position.floorMs).toBeGreaterThan(0);
  });
});

/**
 * Eight writers, each in a loop of transactions of one to four events
 * with a pause inside, while a reader pages through the feed with the
 * cursor it was given: every event read once and in txid order, none
 * skipped. The plan's gate: 0 skipped in 10 000 interleavings.
 */
describe("10 000 events from eight interleaving writers", () => {
  const WRITERS = 8;
  const EVENTS = 10_000;

  it("are all read, once each, in commit order, while they are written", async () => {
    env.INTEGRATION_FEED_ORDER = "commit";

    const repository = new IntegrationRepository(prisma);
    const start = await drain();
    const written = new Set<string>();
    let remaining = EVENTS;
    let writing = WRITERS;

    const writers = await Promise.all(
      Array.from({ length: WRITERS }, () => session()),
    );

    const writer = async (client: pg.Client) => {
      try {
        while (remaining > 0) {
          const size = Math.min(remaining, 1 + Math.floor(Math.random() * 4));

          remaining -= size;

          await client.query("BEGIN");

          const ids: string[] = [];

          for (let i = 0; i < size; i += 1) {
            const id = uuidV7();

            ids.push(id);
            await client.query(INSERT, [id, "stress", deliveryId, CARRIER]);

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
    let cursor = start.resume!;

    const reader = async () => {
      for (;;) {
        const done = writing === 0;
        const result = await repository.listEvents({
          businessId: CARRIER,
          limit: 100,
          position: parseEventCursor(cursor),
        });

        for (const event of result.data) {
          if (event.data.note === "stress") read.push(event.id);
        }

        if (result.resume_cursor) {
          cursor = result.resume_cursor;
          txids.push(parseEventCursor(cursor).txid);
        }

        // One more full pass after the writers stopped, then done.
        if (done && !result.next_cursor) break;
      }
    };

    await Promise.all([...writers.map(writer), reader()]);

    // Nothing skipped, nothing twice.
    expect(written.size).toBe(EVENTS);
    expect(read.length).toBe(EVENTS);
    expect(new Set(read)).toEqual(written);

    // The cursor only moved forward in txid.
    for (let i = 1; i < txids.length; i += 1) {
      expect(txids[i] >= txids[i - 1]).toBe(true);
    }
  }, 240_000);
});
