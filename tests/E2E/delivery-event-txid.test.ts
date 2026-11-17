import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

import { collectAlerts } from "@/shared/health/alert-rules";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  FEED_INDEX,
  feedTxidRegressed,
  readFeedTxidState,
} from "@/shared/health/feed-txid";
import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * delivery_event.txid, the integration feed's commit-order stamp
 * (plano-escala F2-03), on a real Postgres.
 *
 * What the feed of wave 10 (F2-05) will lean on without checking again:
 * every event of one transaction carries that transaction's id, set by the
 * column's DEFAULT and never by the code; the rows from before the column
 * keep NULL and read as 0; the stamp never reaches a response (a BigInt
 * would break the JSON); and the per-minute guard notices a stamp that came
 * from another cluster (a logical restore without `pg_resetwal -e`).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f5a00-0000-7000-8000-00000000000a";
const SHIPPER = "018f5a00-0000-7000-8000-0000000000f1";

let deliveryId: string;
let token: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Txid",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `txid-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  deliveryId = delivery.id;

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração do txid",
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
  await app?.close();
  await prisma.$disconnect();
});

function event(note: string) {
  return prisma.deliveryEvent.create({
    data: { type: "NOTE", note, deliveryId, businessId: CARRIER },
    select: { id: true },
  });
}

async function txids(ids: string[]): Promise<Map<string, bigint | null>> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; txid: string | null }>
  >`
    SELECT "id", "txid"::text AS txid FROM "delivery_event" WHERE "id" = ANY(${ids})
  `;

  return new Map(
    rows.map((row) => [row.id, row.txid === null ? null : BigInt(row.txid)]),
  );
}

describe("the stamp", () => {
  it("is the same for every event of one transaction, and grows between transactions", async () => {
    const [a, b] = await prisma.$transaction([event("a"), event("b")]);
    const c = await event("c");

    const stamps = await txids([a.id, b.id, c.id]);

    expect(stamps.get(a.id)).not.toBeNull();
    expect(stamps.get(a.id)).toBe(stamps.get(b.id));
    expect(stamps.get(c.id)!).toBeGreaterThan(stamps.get(a.id)!);
  });

  it("is the database's own DEFAULT, written as the schema declares it", async () => {
    // prisma/schema.prisma carries this exact text in dbgenerated(): the
    // drift gate (schema-drift.test.ts) compares the two.
    const [row] = await prisma.$queryRaw<Array<{ expr: string }>>`
      SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = 'delivery_event'::regclass AND a.attname = 'txid'
    `;

    expect(row?.expr).toBe("((pg_current_xact_id())::text)::bigint");
  });

  it("never reaches the client or a response", async () => {
    await event("visible");

    // `@ignore`: Prisma neither selects nor returns it.
    const found = await prisma.deliveryEvent.findFirst({
      where: { businessId: CARRIER },
    });

    expect(found).not.toBeNull();
    expect(Object.keys(found!)).not.toContain("txid");

    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/events?limit=200",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.length).toBeGreaterThan(0);
    expect(response.body).not.toContain("txid");
  });
});

describe("the guard against a stamp from another cluster", () => {
  it("reads the largest stamp by one probe per tenant down the feed's index", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`
        EXPLAIN
        SELECT COALESCE(e."txid", 0) FROM "delivery_event" e
        WHERE e."businessId" = '${CARRIER}'
        ORDER BY COALESCE(e."txid", 0) DESC
        LIMIT 1
      `);
    });

    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toContain(FEED_INDEX);
    expect(text).toMatch(/Index (Only )?Scan Backward/);
    expect(text).not.toMatch(/\bSort\b/);
  });

  it("is quiet on this cluster's own stamps, and reads an old NULL row as 0", async () => {
    // A row from before the column: NULL, as every legacy event is.
    await prisma.$executeRaw`
      INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "txid")
      VALUES (${uuidV7()}, 'NOTE'::"DeliveryEventType", 'legado', ${deliveryId}, ${CARRIER}, NULL)
    `;

    const state = await readFeedTxidState(prisma);

    expect(state).not.toBeNull();
    expect(state!.newest).not.toBeNull();
    expect(state!.newest!).toBeLessThan(state!.next);
    expect(feedTxidRegressed(state!)).toBe(false);
  });

  it("fires when a stamp is ahead of the cluster, as after a logical restore", async () => {
    const before = await readFeedTxidState(prisma);
    // Event ids are uuid v7, as Prisma mints them (the trail is partitioned
    // by month on its id, plano-escala F2-16).
    const restored = uuidV7();

    // The simulation: an event whose stamp came from the old cluster's
    // counter, far ahead of this one's.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "txid")
       VALUES ($1, 'NOTE'::"DeliveryEventType", 'restaurado', $2, $3, $4::bigint)`,
      restored,
      deliveryId,
      CARRIER,
      (before!.next + 1_000_000_000n).toString(),
    );

    try {
      const state = await readFeedTxidState(prisma);

      expect(feedTxidRegressed(state!)).toBe(true);

      const codes = collectAlerts({
        now: new Date(),
        outboxEligibleLagSec: null,
        deliveryEligibleLagSec: { internal: null, external: null },
        webhookDueLagSec: null,
        aiEligibleLagSec: null,
        deliveryFailures: [],
        aiCredentialFailures: 0,
        cronJobs: [],
        partitionRunwayOk: true,
        partitionRunwayDays: 7,
        stuckWorkers: [],
        connectionUsagePercent: 1,
        redisOk: true,
        feedTxid: state!,
        collectionErrors: [],
      }).map((alert) => alert.code);

      expect(codes).toEqual(["feed-txid-regressed"]);
    } finally {
      await prisma.deliveryEvent.delete({ where: { id: restored } });
    }

    expect(feedTxidRegressed((await readFeedTxidState(prisma))!)).toBe(false);
  });

  it("waits for the feed's index instead of scanning every tenant", async () => {
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX "${FEED_INDEX}"`);

        const state = await readFeedTxidState(tx);

        throw Object.assign(new Error("rollback"), { state });
      })
      .catch((error: Error & { state?: unknown }) => {
        if (!("state" in error)) throw error;
        return error.state;
      });

    expect(seen).toBeNull();
    expect(await readFeedTxidState(prisma)).not.toBeNull();
  });
});
