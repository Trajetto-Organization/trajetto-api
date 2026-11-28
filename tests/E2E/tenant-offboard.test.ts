import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import { databaseBatch } from "@/../infra/database";
import auth from "@/config/auth";
import { InMemoryArchiveStorage } from "@/shared/archive/in-memory-archive-storage";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  BackgroundJobRepository,
  type ClaimedJob,
} from "@/shared/jobs/background-job-repository";
import { JobStoppedError } from "@/shared/jobs/job-errors";
import { JobRunner, type JobContext } from "@/shared/jobs/job-runner";
import {
  HANDLED_ELSEWHERE,
  TENANT_PURGE_PLAN,
  isDeletingStep,
} from "@/shared/jobs/tenant-offboard/purge-plan";
import {
  TOMBSTONE_RESPONSIBLE,
  createTenantOffboardJob,
  type OffboardProgress,
  type TenantOffboardDeps,
} from "@/shared/jobs/tenant-offboard/tenant-offboard-job";
import { hashSecret } from "@/shared/security/bcrypt-gate";
import type { NotificationService } from "@/shared/services/notification-service";
import type { StorageDeleteOutcome } from "@/shared/services/upload-service";

import { seedSweepCarrier, type CarrierIds } from "./support/idor-sweep-seed";
import { someoneWaitsOnALock } from "./support/lock-wait";

/**
 * A company's purge, the TENANT_OFFBOARD job, on a real Postgres
 * (plano-escala F3-26a; the security review of the plan):
 *
 *  - the plan names every table of the database that holds a company's
 *    rows — the catalog's, raw SQL tables included — and deletes every
 *    child before its parent;
 *  - a company seeded with a row of every kind the sweep knows, plus the
 *    queues, the trail and the AI ledger, is purged to zero rows while
 *    another company's are untouched, no transaction over 5 s, and ends
 *    PURGED: a tombstone without its responsible person's contact;
 *  - stopped half-way, the job resumes from its cursor and finishes;
 *  - a reactivation that commits first wins (nothing deleted); one that
 *    waits behind the job's lock is refused with 409, and nothing is half
 *    alive;
 *  - the old "Deletar" with the e-mailed code goes through the job and
 *    removes the company's row, as it always did.
 */
const prisma = createPrismaClient() as PrismaClient;

let app: Awaited<typeof import("@/http")>["app"];
let masterToken: string;
let masterId: string;

const archive = new InMemoryArchiveStorage();

/**
 * The uploads bucket of these tests: the R2's listing and delete, with the
 * Bucket Lock of deliveryProofs/ (infra/r2/bucket-locks.md) refusing a
 * delete the way R2 does.
 */
class FakeBucket {
  readonly objects = new Set<string>();
  readonly lockedPrefixes = ["deliveryProofs/"];

  async listObjectKeys(prefix: string, startAfter?: string, maxKeys = 1000) {
    return [...this.objects]
      .filter((key) => key.startsWith(prefix))
      .filter((key) => startAfter === undefined || key > startAfter)
      .sort()
      .slice(0, maxKeys);
  }

  async deleteFileOutcome(key: string): Promise<StorageDeleteOutcome> {
    if (this.lockedPrefixes.some((prefix) => key.startsWith(prefix))) {
      return "locked";
    }

    this.objects.delete(key);

    return "deleted";
  }
}

const bucket = new FakeBucket();

function deps(overrides: Partial<TenantOffboardDeps> = {}): TenantOffboardDeps {
  return {
    db: databaseBatch,
    archiveStorage: () => archive,
    trailNow: () => true,
    activities: () =>
      container.resolve<NotificationService>("NotificationService"),
    uploads: () => bucket,
    storagePageSize: 2,
    ...overrides,
  };
}

const store = new BackgroundJobRepository(prisma);

/** Enqueues the company's purge, due now, as the schedule would. */
async function schedulePurgeNow(
  businessId: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  await prisma.business.update({
    where: { id: businessId },
    data: {
      is_active: false,
      deactivated_at: new Date(Date.now() - 60_000),
      purge_state: "SCHEDULED",
      purge_after: new Date(Date.now() - 1_000),
    },
  });

  const { job } = await store.enqueue({
    kind: "TENANT_OFFBOARD",
    businessId,
    subjectId: businessId,
    availableAt: new Date(Date.now() - 1_000),
    payload: { businessId, scheduledById: masterId, ...payload },
  });

  return job.id;
}

async function claimPurge(): Promise<ClaimedJob> {
  const { jobs } = await store.claim({
    limit: 1,
    owner: "e2e",
    kinds: ["TENANT_OFFBOARD"],
    cursor: "",
    maxTenants: 64,
  });

  expect(jobs).toHaveLength(1);

  return jobs[0];
}

/** The runner's context for a claimed job, stopping after `stopAfter`. */
function contextOf(job: ClaimedJob, stopAfter: number | null = null) {
  let checkpoints = 0;

  const context: JobContext = {
    id: job.id,
    kind: job.kind,
    businessId: job.businessId,
    subjectId: job.subjectId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    payload: job.payload,
    progress: job.progress,
    signal: new AbortController().signal,
    throwIfStopped: () => undefined,
    async checkpoint(progress, tx) {
      checkpoints += 1;

      if (stopAfter !== null && checkpoints > stopAfter) {
        throw new JobStoppedError(job.id);
      }

      await store.checkpoint(job.id, job.attempts, progress, tx);
    },
  };

  return context;
}

/** A runner with only the purge, on these deps, run to the end. */
async function runPurge(overrides: Partial<TenantOffboardDeps> = {}) {
  const runner = new JobRunner({ store, owner: () => "e2e" });

  runner.register("TENANT_OFFBOARD", createTenantOffboardJob(deps(overrides)));

  return runner.processBatch();
}

/** Rows of every kind the sweep seed does not make, for one carrier. */
async function seedExtras(ids: CarrierIds): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ids.userId },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      deliveryId: ids.deliveryId,
      businessId: ids.businessId,
      reportedById: ids.userId,
    },
  });
  await prisma.deliveryItem.create({
    data: { description: "Caixa", deliveryId: ids.deliveryId },
  });

  const external = await prisma.externalRecipient.create({
    data: {
      access_token: randomUUID(),
      deliveryId: ids.deliveryId,
      businessId: ids.businessId,
    },
  });

  for (const target of [
    { userId: ids.userId },
    { externalRecipientId: external.id },
  ]) {
    const delivery = await prisma.notificationDelivery.create({
      data: { outboxEventId: randomUUID(), channel: "EMAIL", ...target },
    });

    await prisma.notificationProviderReceipt.create({
      data: {
        deliveryId: delivery.id,
        provider: "resend",
        providerMessageId: randomUUID(),
        status: "delivered",
        occurredAt: new Date(),
      },
    });
  }

  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `e2e:${randomUUID()}`,
      topic: "delivery.updated",
      aggregateType: "delivery",
      aggregateId: ids.deliveryId,
      payload: {},
      businessId: ids.businessId,
    },
  });

  await prisma.outboxEventKey.create({
    data: { event_key: event.eventKey, event_id: event.id },
  });
  await prisma.notificationDeadLetter.create({
    data: {
      id: randomUUID(),
      outboxEventId: event.id,
      topic: "delivery.updated",
      channel: "EMAIL",
      attempts: 5,
      created_at: new Date(),
      failedAt: new Date(),
      businessId: ids.businessId,
    },
  });

  await prisma.chatThreadRead.create({
    data: {
      threadId: ids.threadId,
      userId: ids.userId,
      last_read_at: new Date(),
    },
  });
  await prisma.supportTicketRead.create({
    data: {
      ticketId: ids.ticketId,
      userId: ids.userId,
      last_read_at: new Date(),
    },
  });
  await prisma.pushDeviceToken.create({
    data: { userId: ids.userId, token: randomUUID(), platform: "android" },
  });
  await prisma.forgotPasswordVerificationToken.create({
    data: {
      email: user.email as string,
      token: randomUUID(),
      expires: new Date(Date.now() + 60_000),
    },
  });
  await prisma.driverLastPosition.create({
    data: {
      driverId: ids.driverId,
      businessId: ids.businessId,
      latitude: -23.5,
      longitude: -46.6,
      recorded_at: new Date(),
    },
  });
  await prisma.$executeRaw`
    INSERT INTO "driver_position_v2"
      ("driverId", "businessId", "latitude", "longitude", "recorded_at")
    SELECT ${ids.driverId}::uuid, ${ids.businessId}::uuid, -23.5, -46.6,
           date_trunc('second', now() AT TIME ZONE 'UTC') - make_interval(secs => n)
    FROM generate_series(1, 30) AS n
  `;

  const period = await prisma.aIUsagePeriod.create({
    data: { businessId: ids.businessId, periodStart: new Date() },
  });
  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "FUEL_ODOMETER",
      recordId: ids.fuelId,
      businessId: ids.businessId,
      periodId: period.id,
      requestedById: ids.userId,
      input: {},
    },
  });
  const unit = await prisma.aIAnalysisUnit.create({
    data: { requestId: request.id, unitKey: "odometer" },
  });

  await prisma.aIProviderAttempt.create({
    data: {
      unitId: unit.id,
      attemptNo: 1,
      provider: "local",
      model: "ocr",
      status: "SUCCEEDED",
    },
  });

  // Its objects in the uploads bucket: three photos (two pages), the
  // user's avatar and a locked proof of a delivery with its document.
  for (const name of ["1.jpg", "2.jpg", "3.jpg"]) {
    bucket.objects.add(`odometerPhotos/${ids.businessId}/${name}`);
  }
  bucket.objects.add(`avatars/${ids.userId}/me.jpg`);
  bucket.objects.add(`deliveryProofs/${ids.deliveryId}/sha.pdf`);
  await prisma.deliveryProofDocument.create({
    data: {
      deliveryId: ids.deliveryId,
      businessId: ids.businessId,
      storage_key: `deliveryProofs/${ids.deliveryId}/sha.pdf`,
      sha256: "0".repeat(64),
      verification_token: randomUUID(),
      size_bytes: 1,
    },
  });

  // A driver of the company removed and anonymized (F3-27).
  await prisma.trailArchiveRedaction.create({
    data: { driverId: randomUUID(), businessId: ids.businessId },
  });

  // An archived day of the trail, object and manifest row.
  const key = `trail/20261101/${ids.businessId}.csv.gz`;

  archive.objects.set(key, Buffer.from("gz"));
  await prisma.$executeRaw`
    INSERT INTO "archive_manifest"
      ("id", "source_table", "partition_name", "businessId", "object_key",
       "status", "row_count", "created_at", "archived_at")
    VALUES (${randomUUID()}, 'driver_position_v2',
            ${`driver_position_v2_20261101_${ids.businessId.slice(-4)}`},
            ${ids.businessId}, ${key}, 'ARCHIVED'::"ArchiveObjectStatus", 30,
            now(), now())
  `;

  // A closed day of the dashboard and a day marked dirty (F4-20). The
  // purge's own DELETEs of the deliveries mark more days by trigger: the
  // counts below prove those leave too.
  await prisma.tenantDayCount.create({
    data: {
      businessId: ids.businessId,
      metric: "delivery",
      day: new Date("2026-11-01T00:00:00Z"),
      value: 3n,
    },
  });
  await prisma.tenantDayDirty.create({
    data: { businessId: ids.businessId, day: new Date("2026-10-31T00:00:00Z") },
  });
  // A socket's beat (plano-escala U-05): rides the login's cascade.
  await prisma.userPresence.create({
    data: { user_id: ids.userId, heartbeat_at: new Date() },
  });
}

/** Row counts of every table the plan deletes from. */
async function planCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const step of TENANT_PURGE_PLAN) {
    if (!isDeletingStep(step)) continue;

    for (const table of [step.table, ...(step.cascades ?? [])]) {
      if (table in counts) continue;

      const [present] = await prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT to_regclass(quote_ident(${table})) IS NOT NULL AS "ok"
      `;

      if (!present.ok) continue;

      const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "${table}"`,
      );

      counts[table] = row.n;
    }
  }

  return counts;
}

const cancel = (businessId: string) =>
  app.inject({
    method: "POST",
    url: `/business/cancel-business-purge/${businessId}`,
    headers: { authorization: `Bearer ${masterToken}` },
  });

beforeAll(async () => {
  masterId = randomUUID();

  await prisma.user.create({
    data: {
      id: masterId,
      name: "Mestre",
      email: `${masterId}@exemplo.com.br`,
      password: "not-used-here",
      role: "MASTER",
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: masterId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  masterToken = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: masterId, expiresIn: "15m" },
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the purge plan against the database's catalog", () => {
  it("names every table that holds a company's rows and deletes children first", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ name: string; company: boolean }>
    >`
      SELECT c.relname::text AS "name",
             EXISTS (
               SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND NOT a.attisdropped
                 AND a.attname IN ('businessId', 'business_id')
             ) AS "company"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    `;
    const keys = await prisma.$queryRaw<
      Array<{ child: string; parent: string }>
    >`
      SELECT child.relname::text AS "child", parent.relname::text AS "parent"
      FROM pg_constraint k
      JOIN pg_class child ON child.oid = k.conrelid
      JOIN pg_class parent ON parent.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE k.contype = 'f' AND n.nspname = current_schema()
        AND NOT child.relispartition
    `;

    const company = new Set(
      tables
        .filter((table) => table.company && table.name !== "business")
        .map((table) => table.name),
    );

    for (let grew = true; grew;) {
      grew = false;

      for (const { child, parent } of keys) {
        if (
          (company.has(parent) || parent === "business") &&
          child !== "business" &&
          !company.has(child)
        ) {
          company.add(child);
          grew = true;
        }
      }
    }

    const named = new Set<string>();
    const at = new Map<string, number[]>();
    const rides = new Map<string, string[]>();

    TENANT_PURGE_PLAN.forEach((step, index) => {
      named.add(step.table);

      if (!isDeletingStep(step)) return;

      for (const table of [step.table, ...(step.cascades ?? [])]) {
        named.add(table);
        at.set(table, [...(at.get(table) ?? []), index]);
      }

      for (const child of step.cascades ?? []) {
        rides.set(child, [step.table, ...(step.cascades ?? [])]);
      }
    });

    expect(
      [...company]
        .filter((table) => !named.has(table) && !(table in HANDLED_ELSEWHERE))
        .sort(),
    ).toEqual([]);

    const wrong = keys.filter(({ child, parent }) => {
      const childAt = at.get(child);
      const parentAt = at.get(parent);

      if (!childAt || !parentAt || child === parent) return false;
      if (rides.get(child)?.includes(parent)) return false;

      return Math.max(...childAt) >= Math.min(...parentAt);
    });

    expect(wrong).toEqual([]);
  });

  it("picks every batch by the table's primary key", async () => {
    const primary = await prisma.$queryRaw<
      Array<{ name: string; columns: string[] }>
    >`
      SELECT c.relname::text AS "name",
             array_agg(a.attname::text ORDER BY k.ord) AS "columns"
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indisprimary AND n.nspname = current_schema()
        AND NOT c.relispartition
      GROUP BY c.relname
    `;
    const keyOf = new Map(primary.map((row) => [row.name, row.columns]));

    for (const step of TENANT_PURGE_PLAN) {
      if (!isDeletingStep(step) || !keyOf.has(step.table)) continue;

      expect([...(step.key ?? ["id"])].sort(), step.table).toEqual(
        [...(keyOf.get(step.table) as string[])].sort(),
      );
    }
  });
});

describe("purging a company", () => {
  let gone: CarrierIds;
  let kept: CarrierIds;
  let jobId: string;
  let before: Record<string, number>;

  beforeAll(async () => {
    kept = await seedSweepCarrier(prisma, { label: "B", marker: "MANTIDA" });
    await seedExtras(kept);

    // What the database holds without the company that leaves: the purge
    // must bring every table of the plan back to exactly this.
    before = await planCounts();

    gone = await seedSweepCarrier(prisma, { label: "A", marker: "APAGADA" });
    await seedExtras(gone);

    jobId = await schedulePurgeNow(gone.businessId);
  }, 120_000);

  it("deletes every row of the company and nothing of another", async () => {
    expect(await runPurge()).toBe(1);

    const after = await planCounts();

    // The platform's own audit line about the purge is the one row more.
    expect(after).toEqual({ ...before, activity: before.activity + 1 });

    // Its deliveries' DELETEs marked their days by trigger (F4-20), and
    // the last steps took those marks too; the other company keeps its own.
    for (const [businessId, rows] of [
      [gone.businessId, 0],
      [kept.businessId, 1],
    ] as const) {
      expect(await prisma.tenantDayDirty.count({ where: { businessId } })).toBe(
        rows,
      );
      expect(await prisma.tenantDayCount.count({ where: { businessId } })).toBe(
        rows,
      );
    }

    // Its uploads went, but the proof the bucket's lock holds (retained);
    // the other company's are all there.
    expect([...bucket.objects].sort()).toEqual(
      [
        `avatars/${kept.userId}/me.jpg`,
        `deliveryProofs/${gone.deliveryId}/sha.pdf`,
        `deliveryProofs/${kept.deliveryId}/sha.pdf`,
        ...["1.jpg", "2.jpg", "3.jpg"].map(
          (name) => `odometerPhotos/${kept.businessId}/${name}`,
        ),
      ].sort(),
    );

    // The other company's archive stays; this one's object and row went.
    expect([...archive.objects.keys()]).toEqual([
      `trail/20261101/${kept.businessId}.csv.gz`,
    ]);
    expect(
      await prisma.archiveManifest.count({
        where: { businessId: gone.businessId },
      }),
    ).toBe(0);

    const [trail] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM "driver_position_v2"
      WHERE "driverId" = ${gone.driverId}::uuid
    `;

    expect(trail.n).toBe(0);
  });

  it("ends PURGED: a tombstone without the responsible person's contact", async () => {
    const company = await prisma.business.findUniqueOrThrow({
      where: { id: gone.businessId },
    });

    expect(company).toMatchObject({
      purge_state: "PURGED",
      is_active: false,
      responsible_name: TOMBSTONE_RESPONSIBLE,
      telephone: "",
      erp_code: null,
    });
    expect(company.email).not.toContain("exemplo.com.br");
    expect(
      await prisma.business.findUniqueOrThrow({
        where: { id: kept.businessId },
      }),
    ).toMatchObject({ purge_state: null, is_active: true });

    // The platform's audit trail says when, under no company.
    expect(
      await prisma.activity.count({
        where: {
          entityId: gone.businessId,
          businessId: null,
          action: "delete",
        },
      }),
    ).toBe(1);
  });

  it("keeps every transaction of the purge under 5 s", async () => {
    const job = await prisma.backgroundJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    const progress = job.progress as unknown as OffboardProgress;

    expect(job.status).toBe("SUCCEEDED");
    expect(progress.phase).toBe("done");
    expect(progress.deleted).toBeGreaterThan(50);
    expect(progress.maxTransactionMs).toBeLessThan(5_000);
    expect(progress.storage).toMatchObject({ deleted: 4, retained: 1 });
  });
});

describe("a purge stopped half-way", () => {
  it("resumes from its cursor and finishes", async () => {
    const ids = await seedSweepCarrier(prisma, {
      label: "R",
      marker: "RETOMADA",
    });
    const handler = createTenantOffboardJob(deps());

    await schedulePurgeNow(ids.businessId);

    const first = await claimPurge();

    // A SIGTERM at the 25th checkpoint, past the bucket: rolled back with its batch.
    await expect(handler.run(contextOf(first, 25))).rejects.toBeInstanceOf(
      JobStoppedError,
    );
    expect(await store.giveBack(first.id, first.attempts)).toBe(true);

    const second = await claimPurge();
    const cursor = second.progress as OffboardProgress;

    expect(cursor.phase).toBe("rows");
    expect(cursor.step).toBeGreaterThan(0);
    expect(
      await prisma.business.findUniqueOrThrow({
        where: { id: ids.businessId },
      }),
    ).toMatchObject({ purge_state: "PURGING" });

    await handler.run(contextOf(second));
    expect(await store.complete(second.id, second.attempts)).toBe(true);

    expect(
      await prisma.delivery.count({ where: { businessId: ids.businessId } }),
    ).toBe(0);
    expect(
      await prisma.user.count({ where: { businessId: ids.businessId } }),
    ).toBe(0);
    expect(
      await prisma.business.findUniqueOrThrow({
        where: { id: ids.businessId },
      }),
    ).toMatchObject({ purge_state: "PURGED" });
  });
});

describe("a reactivation racing the purge", () => {
  it("wins when it commits first: the job deletes nothing", async () => {
    const ids = await seedSweepCarrier(prisma, {
      label: "C",
      marker: "REATIVADA",
    });

    await schedulePurgeNow(ids.businessId);

    // Claimed (PROCESSING), so the cancel cannot cancel it: the job's own
    // check is what keeps the company.
    const job = await claimPurge();

    expect((await cancel(ids.businessId)).statusCode).toBe(200);

    await createTenantOffboardJob(deps()).run(contextOf(job));
    expect(await store.complete(job.id, job.attempts)).toBe(true);

    expect(
      await prisma.business.findUniqueOrThrow({
        where: { id: ids.businessId },
      }),
    ).toMatchObject({ is_active: true, purge_state: null });
    expect(
      await prisma.delivery.count({ where: { businessId: ids.businessId } }),
    ).toBe(3);
  });

  it("is refused with 409 when it waits behind the job's lock", async () => {
    const ids = await seedSweepCarrier(prisma, {
      label: "D",
      marker: "DISPUTADA",
    });

    await schedulePurgeNow(ids.businessId);

    let reached!: () => void;
    let release!: () => void;
    const atLock = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;

    // The job's first transaction (PURGING) waits before its commit, with
    // the company's row locked, until the reactivation is parked behind it.
    const gated: TenantOffboardDeps["db"] = {
      $transaction: ((
        work: (tx: unknown) => Promise<unknown>,
        options: never,
      ) =>
        databaseBatch.$transaction(async (tx) => {
          const value = await work(tx);

          if (!held) {
            held = true;
            reached();
            await released;
          }

          return value;
        }, options)) as TenantOffboardDeps["db"]["$transaction"],
      $queryRaw: databaseBatch.$queryRaw.bind(databaseBatch),
      $executeRaw: databaseBatch.$executeRaw.bind(databaseBatch),
      $queryRawUnsafe: databaseBatch.$queryRawUnsafe.bind(databaseBatch),
      $executeRawUnsafe: databaseBatch.$executeRawUnsafe.bind(databaseBatch),
    };

    const job = await claimPurge();
    const purging = createTenantOffboardJob(deps({ db: gated })).run(
      contextOf(job),
    );

    await atLock;

    const reactivating = cancel(ids.businessId);

    await someoneWaitsOnALock(prisma, { what: "company's row" });
    release();

    const response = await reactivating;

    await purging;
    expect(await store.complete(job.id, job.attempts)).toBe(true);

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("BUSINESS_PURGE_RUNNING");
    expect(
      await prisma.business.findUniqueOrThrow({
        where: { id: ids.businessId },
      }),
    ).toMatchObject({ is_active: false, purge_state: "PURGED" });
    expect(
      await prisma.delivery.count({ where: { businessId: ids.businessId } }),
    ).toBe(0);
  });
});

describe("the old Deletar with the e-mailed code", () => {
  it("hands the company to the job, which removes its row", async () => {
    const business = await prisma.business.create({
      data: {
        corporate_reason: `Vazia ${randomUUID()}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: String(Date.now()).padStart(14, "7").slice(-14),
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `${randomUUID()}@exemplo.com.br`,
      },
    });

    await prisma.vehicleType.create({
      data: {
        description: "Truck",
        number_of_axles: 3,
        businessId: business.id,
      },
    });
    await prisma.pendingDeletion.create({
      data: {
        entity_type: "business",
        entity_id: business.id,
        userId: masterId,
        code_hash: await hashSecret("123456", 4),
        expires: new Date(Date.now() + 60_000),
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/business/delete-business/${business.id}`,
      headers: { authorization: `Bearer ${masterToken}` },
      payload: { code: "123456" },
    });

    expect(response.statusCode).toBe(200);
    expect(
      await prisma.business.findUniqueOrThrow({ where: { id: business.id } }),
    ).toMatchObject({ is_active: false, purge_state: "SCHEDULED" });
    expect(
      await prisma.backgroundJob.findFirstOrThrow({
        where: { kind: "TENANT_OFFBOARD", subjectId: business.id },
      }),
    ).toMatchObject({
      status: "PENDING",
      payload: expect.objectContaining({ removeRow: true }),
    });

    expect(await runPurge()).toBe(1);

    expect(await prisma.business.count({ where: { id: business.id } })).toBe(0);
    expect(
      await prisma.vehicleType.count({ where: { businessId: business.id } }),
    ).toBe(0);
    expect(
      await prisma.activity.count({
        where: { entityId: business.id, businessId: null },
      }),
    ).toBe(2);
  });
});
