import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { env } from "@/env";
import { parseEventCursor } from "@/modules/integration/cursor";
import { createPrismaClient } from "@/shared/database/database-client";
import { collectAlerts } from "@/shared/health/alert-rules";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { takeFeedCounts } from "@/shared/integration/feed-metrics";

/**
 * A cursor of another cluster epoch (plano-escala F2-05, D67), on a real
 * Postgres and through the route.
 *
 * After a PITR, a promote or a logical restore the cluster hands out
 * transaction ids again, and the release step bumps cluster_epoch (U-14).
 * An integrator still holding a cursor of the epoch before would be read
 * against txids that mean something else, and could skip events for good.
 * So the feed converts it from its floor (the created_at of the last event
 * it served minus FEED_FLOOR_MARGIN_MS): everything written since then
 * comes again, at least once, none is skipped, the cursor it hands back
 * carries the new epoch, and the conversion is counted and pages
 * feed-epoch-conversion.
 *
 * The epoch is moved by hand here, as the cluster-epoch E2E simulates a
 * promote. One connection only, so the shared phase is fine: another
 * file's open transaction only delays the page, which is waited for.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f5d00-0000-7000-8000-00000000000a";
const SHIPPER = "018f5d00-0000-7000-8000-0000000000f1";

let deliveryId: string;
let token: string;
let epochBefore: number;

beforeAll(async () => {
  env.INTEGRATION_FEED_ORDER = "commit";

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Época",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000185",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `epoch-${randomUUID()}@example.com`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  deliveryId = (
    await prisma.delivery.create({
      data: {
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    })
  ).id;

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração da época",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["events:read"],
      businessId: CARRIER,
    },
  });

  token = key.token;

  const [row] = await prisma.$queryRaw<Array<{ epoch: number }>>`
    SELECT "epoch" FROM "cluster_epoch" WHERE "id" = 1
  `;

  epochBefore = row.epoch;

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  env.INTEGRATION_FEED_ORDER = "id";

  await prisma.$executeRaw`
    UPDATE "cluster_epoch" SET "epoch" = ${epochBefore} WHERE "id" = 1
  `;
  await app?.close();
  await prisma.$disconnect();
});

const note = (text: string) =>
  prisma.deliveryEvent.create({
    data: { type: "NOTE", note: text, deliveryId, businessId: CARRIER },
  });

async function drain(cursor?: string) {
  const notes: string[] = [];
  let next = cursor;
  let resume: string | null = cursor ?? null;

  for (;;) {
    const query = new URLSearchParams({ limit: "200" });

    if (next) query.set("cursor", next);

    const response = await app.inject({
      method: "GET",
      url: `/integration/v1/events?${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const body = response.json() as {
      data: Array<{ data: { note: string | null } }>;
      next_cursor: string | null;
      resume_cursor: string | null;
    };

    notes.push(...body.data.map((event) => event.data.note ?? ""));
    resume = body.resume_cursor ?? resume;

    if (!body.next_cursor) break;
    next = body.next_cursor;
  }

  return { notes, resume };
}

describe("a cursor of the epoch before", () => {
  it("brings back everything since its floor, skips nothing, and hands out the new epoch", async () => {
    for (const text of ["a", "b", "c"]) await note(text);

    const before = await vi.waitFor(
      async () => {
        const result = await drain();

        expect(result.notes).toEqual(["a", "b", "c"]);

        return result;
      },
      { timeout: 45_000, interval: 200 },
    );

    expect(parseEventCursor(before.resume!).epoch).toBe(epochBefore);

    // A promote, as the release step would record it.
    await prisma.$executeRaw`
      UPDATE "cluster_epoch" SET "epoch" = ${epochBefore + 1} WHERE "id" = 1
    `;

    await note("d");
    takeFeedCounts();

    const after = await vi.waitFor(
      async () => {
        const result = await drain(before.resume!);

        expect(result.notes).toContain("d");

        return result;
      },
      { timeout: 45_000, interval: 200 },
    );

    // The floor is minutes behind the last event served: a, b and c come
    // again (deduplicated by id on the other side), and d after them.
    expect(after.notes).toEqual(["a", "b", "c", "d"]);
    expect(parseEventCursor(after.resume!).epoch).toBe(epochBefore + 1);
    expect(takeFeedCounts().epoch_conversions).toBeGreaterThan(0);

    // The new cursor is read as it is: nothing again.
    expect((await drain(after.resume!)).notes).toEqual([]);
  }, 120_000);

  it("pages feed-epoch-conversion from the processes' rows", async () => {
    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");

    await prisma.opsSample.create({
      data: {
        ts: new Date(),
        role: "all",
        replica: "feed-epoch-e2e",
        commit: null,
        metrics: {
          v: 1,
          feed: { epoch_conversions: 2, legacy_conversions: 0 },
        },
      },
    });

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.feedEpochConversions).toBeGreaterThanOrEqual(2);
    expect(collectAlerts(snapshot).map((alert) => alert.code)).toContain(
      "feed-epoch-conversion",
    );
  }, 60_000);
});
