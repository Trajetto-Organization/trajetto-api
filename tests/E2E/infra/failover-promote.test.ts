// @vitest-environment node
import { resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";
import pg from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
} from "infra/scripts/release-step-runner";

import { env } from "@/env";
import { parseEventCursor } from "@/modules/integration/cursor";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  clusterEpochStaleReason,
  readClusterEpochState,
} from "@/shared/health/cluster-epoch";
import { takeFeedCounts } from "@/shared/integration/feed-metrics";

import { infraUrl } from "./support/infra-urls";

/**
 * The failover, as the runbook does it (plano-escala F4-44,
 * docs/runbooks/failover-standby.md), on a standby of the infra phase that
 * only this file uses (tests/E2E/infra/run.sh, `<prefix>promote`).
 *
 * After pg_promote() the cluster writes on a new timeline at once, and the
 * transaction ids go on from wherever the standby had replayed: an
 * integrator's cursor may name an xid the old primary handed out and this
 * history will hand out again. The release step run right after the
 * promote must bump the cluster's epoch then, not after the new timeline's
 * first checkpoint (a spread one, minutes later: that is what
 * pg_control_checkpoint() reports until then), and the per-minute check
 * must agree. An old poller's cursor, of the old epoch, is then converted
 * from its floor: events repeat, none is skipped.
 *
 * Here the primary keeps running (the other files need it); in a real
 * failover it is stopped first, and the promoted standby is the only one.
 */
const EPOCH_STEP = "infra/sql/50-cluster-epoch.sql";
const INSERT = `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId") VALUES ($1, 'NOTE', $2, $3, $4)`;

let primary: PrismaClient;
let promoted: PrismaClient;
const sessions: pg.Client[] = [];
const order = env.INTEGRATION_FEED_ORDER;

async function session(url: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    application_name: "failover-promote-e2e",
  });

  await client.connect();
  sessions.push(client);

  return client;
}

/** A company with one delivery, on the primary; its id and the delivery's. */
async function company(): Promise<[string, string]> {
  const id = uuidV7();
  const shipperId = uuidV7();
  const cnpj =
    String(Date.now() + 7)
      .slice(-8)
      .padStart(8, "0") + "000272";

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
      email: `failover-${id}@example.com`,
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

/** Every page from `cursor` on, on `repository`: the ids and where to resume. */
async function drain(
  repository: IntegrationRepository,
  businessId: string,
  cursor: string | null,
) {
  const ids: string[] = [];
  let next = cursor;

  for (;;) {
    const page = await repository.listEvents({
      businessId,
      limit: 100,
      position: next ? parseEventCursor(next) : undefined,
    });

    ids.push(...page.data.map((event) => event.id));
    next = page.resume_cursor ?? next;
    if (!page.next_cursor) break;
  }

  return { ids, cursor: next };
}

async function epochStep(url: string) {
  const step = listReleaseSteps(resolve(process.cwd())).find(
    (each) => each.step === EPOCH_STEP,
  );

  if (!step) throw new Error(`${EPOCH_STEP} não foi encontrado`);

  const client = await openReleaseClient(url, "e2e-failover-promote");

  try {
    const outcome = await runReleaseSteps(client, [step], {
      log: { info: () => undefined, warn: () => undefined },
      postDeploy: false,
    });

    return outcome.steps[0];
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  primary = createPrismaClient({}, { url: infraUrl("primary") });
  promoted = createPrismaClient({}, { url: infraUrl("promote") });
  env.INTEGRATION_FEED_ORDER = "commit";
});

afterAll(async () => {
  env.INTEGRATION_FEED_ORDER = order;

  for (const client of sessions) await client.end().catch(() => undefined);
  await promoted.$disconnect();
  await primary.$disconnect();
});

describe("a failover to the promoted standby", () => {
  it("bumps the cluster's epoch in the release step right after the promote, and converts an old poller's cursor without skipping", async () => {
    const [carrier, deliveryId] = await company();
    const writer = await session(infraUrl("primary"));
    const before: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      const id = uuidV7();

      before.push(id);
      await writer.query(INSERT, [id, "before", deliveryId, carrier]);
    }

    // The old poller, on the primary: it read everything so far.
    const onPrimary = new IntegrationRepository(primary, () => null);
    const old = await drain(onPrimary, carrier, null);

    expect(old.ids).toEqual(before);

    const epochBefore = parseEventCursor(old.cursor!).epoch!;

    // Written after the poller's last page, and replayed by the standby.
    const unseen: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      const id = uuidV7();

      unseen.push(id);
      await writer.query(INSERT, [id, "unseen", deliveryId, carrier]);
    }

    const [{ lsn }] = await primary.$queryRawUnsafe<Array<{ lsn: string }>>(
      "SELECT pg_current_wal_lsn()::text AS lsn",
    );
    const target = await session(infraUrl("promote"));

    await vi.waitFor(
      async () => {
        const { rows } = await target.query<{ done: boolean }>(
          `SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS done`,
          [lsn],
        );

        expect(rows[0].done).toBe(true);
      },
      { timeout: 30_000, interval: 100 },
    );

    // The promote: a new timeline at once, no checkpoint asked for.
    const { rows: promote } = await target.query<{ promoted: boolean }>(
      "SELECT pg_promote() AS promoted",
    );

    expect(promote[0].promoted).toBe(true);

    const { rows: timeline } = await target.query<{ wal: number }>(
      `SELECT ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::integer AS wal`,
    );

    expect(timeline[0].wal).toBeGreaterThanOrEqual(2);

    // Seen as stale until the step runs, then bumped by it.
    const stale = await readClusterEpochState(promoted);

    expect(clusterEpochStaleReason(stale!)).toMatch(/timeline/);

    // And the feed serves no page there meanwhile: the old poller's cursor,
    // still of the current epoch, would be read as a position in this
    // history (the review of wave 17). The runbook runs the step before
    // traffic comes back; this holds even when it does not.
    await expect(
      drain(
        new IntegrationRepository(promoted, () => null),
        carrier,
        old.cursor,
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "SERVICE_UNAVAILABLE" });

    expect(await epochStep(infraUrl("promote"))).toMatchObject({
      step: EPOCH_STEP,
      status: "applied",
    });

    const state = await readClusterEpochState(promoted);

    expect(state?.stored?.epoch).toBe(epochBefore + 1);
    expect(state?.stored?.timeline).toBe(timeline[0].wal);
    expect(clusterEpochStaleReason(state!)).toBeNull();
    // And it says so once: a second run changes nothing.
    expect(await epochStep(infraUrl("promote"))).toMatchObject({
      status: "skipped",
    });

    // The new history writes on.
    const after: string[] = [];
    const newWriter = await session(infraUrl("promote"));

    for (let i = 0; i < 5; i += 1) {
      const id = uuidV7();

      after.push(id);
      await newWriter.query(INSERT, [id, "after", deliveryId, carrier]);
    }

    // The old poller comes back, now served by the promoted standby: its
    // cursor is of the old epoch, converted from its floor, never trusted.
    takeFeedCounts();

    const onPromoted = new IntegrationRepository(promoted, () => null);
    const resumed = await drain(onPromoted, carrier, old.cursor);

    for (const id of [...unseen, ...after]) {
      expect(resumed.ids, id).toContain(id);
    }
    expect(parseEventCursor(resumed.cursor!).epoch).toBe(epochBefore + 1);
    expect(takeFeedCounts().epoch_conversions).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
