import { Prisma, type PrismaClient } from "@prisma/client";
import { container } from "tsyringe";

import database, { databaseBatch } from "@/../infra/database";
import type { JobContext, JobHandler } from "@/shared/jobs/job-runner";
import { PermanentJobError } from "@/shared/jobs/job-errors";
import { logger } from "@/shared/logging/logger";
import { deleteQueueRowsOfUser } from "@/shared/notifications/queue-row-cleanup";
import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";
import { sendCatalogChangedEvent } from "@/websocket";

const log = logger.child({ component: "jobs", kind: "USER_ANONYMIZE" });

/**
 * The USER_ANONYMIZE job (plano-escala F3-27, decision D49): a driver, or a
 * panel login, who worked and asked to be removed. Deleting them would take
 * the history with them (driverHistoryRefusal, USER_HAS_RECORDS), so the
 * person goes and the history stays:
 *
 *  - out: the name (it becomes "Motorista removido" or "Usuário removido"),
 *    the CPF, the RG, the CNH, the birth date and the address; the e-mail,
 *    the WhatsApp phone and the photo (its objects too); the sessions,
 *    the push tokens, the trusted devices, the 2FA and every e-mailed
 *    token; the bell and its deliveries; the hot GPS trail and the last
 *    position; the phone that sent each delivery event (`device`,
 *    `device_id`);
 *  - kept: deliveries, proofs, signatures, messages, occurrences and every
 *    record the person made, under the anonymous author; the login, revoked
 *    and without an e-mail, so nobody signs in as it again. The audit
 *    trail's lines stay too, with the person's name, documents, e-mail and
 *    phone taken out of their text.
 *
 * What the job leaves, by design: the queues' payloads (the outbox events,
 *  the webhook ledger) leave with their retention, 30 days; the archived
 *  trail, with the archive's (180 days), filtered on a restore.
 *
 * Phases, each resumed from the job's cursor:
 *
 *  0. activities: the company's audit trail, a chunk at a time, with the
 *     person's name replaced by the label and the documents, the e-mail and
 *     the phone by "***". First, while the person's data is still in the
 *     rows the job reads it from (it is never copied into the job's cursor);
 *  1. identity: one transaction on the app's pool (the worker's login) —
 *     the driver's and the login's rows, the tokens and devices, the bell,
 *     the last position, the archive's redaction (trail_archive_redaction:
 *     a restore of the archived trail leaves the driver out) and the audit
 *     line. After its commit a driver's company hears `catalogChanged`
 *     driver, as every other driver write does: the pickers trust that
 *     hint for two minutes, and they kept offering the old name, ACTIVE,
 *     until then (audit of 25/11/2026);
 *  2. avatar: the login's photos in the uploads bucket;
 *  3. trail: the driver's hot trail, by its primary key (driverId,
 *     recorded_at) in every partition, in short batches;
 *  4. events: the phone on each delivery event the login reported, walked
 *     by the company's (businessId, id) index in chunks. On the maintenance
 *     pool: after the cut of the roles only trajetto_batch may change a
 *     column of the delivery trail other than the GPS address
 *     (infra/sql/20-runtime-roles.sql), and the trail's DELETEs are its own
 *     too.
 */

type AnonymizeSubject = "driver" | "user";

type AnonymizePhase =
  "activities" | "identity" | "avatar" | "trail" | "events" | "done";

interface AnonymizePayload {
  subject: AnonymizeSubject;

  /** The driver's id, or the login's. */
  subjectId: string;
  businessId: string;
  requestedById: string | null;
}

interface AnonymizeProgress {
  v: 1;
  phase: AnonymizePhase;

  /** The driver anonymized, when the subject is one. */
  driverId: string | null;

  /** The login anonymized: the driver's, or the subject itself. */
  userId: string | null;

  /** The table of the current phase (the trail's, the events'). */
  table: number;

  /** The phase's cursor: the last key listed or walked. */
  cursor: string;

  trailRows: number;
  events: number;
  objects: number;
}

/** What the job reads and writes through; the tests pass their own. */
interface UserAnonymizeDeps {
  /** The identity: the worker's login after the cut. */
  db: Pick<PrismaClient, "$transaction">;

  /** The trail and the events: trajetto_batch after the cut. */
  batch: Pick<PrismaClient, "$transaction" | "$queryRaw">;
  uploads: () => Pick<UploadService, "listObjectKeys" | "deleteFileOutcome">;
  activities: () => Pick<NotificationService, "createActivityIfEnabled">;
}

const DRIVER_LABEL = "Motorista removido";
const USER_LABEL = "Usuário removido";

/** The trail's tables and their keys, the lean one first. */
const TRAIL_TABLES = [
  { table: "driver_position_v2", cast: "uuid" },
  { table: "driver_position", cast: "text" },
] as const;

/** The delivery trail, and its partitioned shell while it exists (F2-17). */
const EVENT_TABLES = ["delivery_event", "delivery_event_part"] as const;

const TRAIL_BATCH = 5_000;
const ACTIVITY_CHUNK = 5_000;

/** A term shorter than this is not replaced: it would hit other words. */
const MIN_TERM_LENGTH = 3;
const EVENT_CHUNK = 5_000;
const AVATAR_PAGE = 1_000;

/** Every transaction of the job stays short, as the purge's do. */
const TRANSACTION_MS = 5_000;
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '3000ms'";

function freshProgress(): AnonymizeProgress {
  return {
    v: 1,
    phase: "activities",
    driverId: null,
    userId: null,
    table: 0,
    cursor: "",
    trailRows: 0,
    events: 0,
    objects: 0,
  };
}

function progressOf(value: unknown): AnonymizeProgress {
  if (typeof value !== "object" || value === null) return freshProgress();

  const progress = value as Partial<AnonymizeProgress>;

  if (progress.v !== 1) return freshProgress();

  return { ...freshProgress(), ...progress } as AnonymizeProgress;
}

function payloadOf(job: JobContext): AnonymizePayload {
  const payload = (job.payload ?? {}) as Partial<AnonymizePayload>;

  if (
    (payload.subject !== "driver" && payload.subject !== "user") ||
    typeof payload.subjectId !== "string" ||
    typeof payload.businessId !== "string"
  ) {
    throw new PermanentJobError("USER_ANONYMIZE sem sujeito ou empresa");
  }

  return {
    subject: payload.subject,
    subjectId: payload.subjectId,
    businessId: payload.businessId,
    requestedById: payload.requestedById ?? null,
  };
}

type Tx = Prisma.TransactionClient;

interface Subject {
  driverId: string | null;
  driverName: string | null;
  userId: string | null;
  userName: string | null;
  email: string | null;
}

/** The subject's rows, locked; null when it is gone or not the company's. */
async function lockSubject(
  tx: Tx,
  payload: AnonymizePayload,
): Promise<Subject | null> {
  if (payload.subject === "driver") {
    const [row] = await tx.$queryRaw<
      Array<{
        driver_id: string;
        driver_name: string;
        user_id: string | null;
        user_name: string | null;
        email: string | null;
      }>
    >`
      SELECT d."id" AS "driver_id", d."name" AS "driver_name",
             u."id" AS "user_id", u."name" AS "user_name", u."email"
      FROM "driver" d
      LEFT JOIN "user" u ON u."driverId" = d."id"
      WHERE d."id" = ${payload.subjectId}
        AND d."businessId" = ${payload.businessId}
      FOR UPDATE OF d
    `;

    return row
      ? {
          driverId: row.driver_id,
          driverName: row.driver_name,
          userId: row.user_id,
          userName: row.user_name,
          email: row.email,
        }
      : null;
  }

  const [row] = await tx.$queryRaw<
    Array<{ id: string; name: string; email: string | null }>
  >`
    SELECT "id", "name", "email" FROM "user"
    WHERE "id" = ${payload.subjectId} AND "businessId" = ${payload.businessId}
    FOR UPDATE
  `;

  return row
    ? {
        driverId: null,
        driverName: null,
        userId: row.id,
        userName: row.name,
        email: row.email,
      }
    : null;
}

/** What the audit trail's text may carry of the person, read live. */
interface PersonTerms {
  /** Replaced by the label. */
  names: string[];

  /** Replaced by "***": documents, e-mail, phone. */
  secrets: string[];
}

/** The person's terms, from the rows as they are now; null when gone. */
async function personTerms(
  tx: Tx,
  payload: AnonymizePayload,
): Promise<PersonTerms | null> {
  const rows =
    payload.subject === "driver"
      ? await tx.$queryRaw<Array<Record<string, string | null>>>`
          SELECT d."name" AS "name", d."cpf", d."cnh", d."rg",
                 u."name" AS "login", u."email", u."whatsapp_phone"
          FROM "driver" d
          LEFT JOIN "user" u ON u."driverId" = d."id"
          WHERE d."id" = ${payload.subjectId}
            AND d."businessId" = ${payload.businessId}
            AND d."anonymized_at" IS NULL
        `
      : await tx.$queryRaw<Array<Record<string, string | null>>>`
          SELECT "name", "email", "whatsapp_phone"
          FROM "user"
          WHERE "id" = ${payload.subjectId}
            AND "businessId" = ${payload.businessId}
            AND "anonymized_at" IS NULL
        `;
  const [row] = rows;

  if (!row) return null;

  const keep = (values: Array<string | null | undefined>) =>
    [...new Set(values)]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length >= MIN_TERM_LENGTH,
      )
      .map((value) => value.trim());

  return {
    names: keep([row.name, row.login]),
    secrets: keep([row.cpf, row.cnh, row.rg, row.email, row.whatsapp_phone]),
  };
}

/** `value` as a literal in a Postgres regular expression. */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Phase 0: the person out of the company's audit trail's text, one chunk
 * of its lines (by the company's (businessId, created_at) index) per
 * transaction. A name is replaced whole-word; a document, an e-mail or a
 * phone anywhere.
 */
async function scrubActivities(
  deps: UserAnonymizeDeps,
  job: JobContext,
  payload: AnonymizePayload,
  progress: AnonymizeProgress,
): Promise<AnonymizeProgress> {
  const label = payload.subject === "driver" ? DRIVER_LABEL : USER_LABEL;
  let current = progress;

  for (;;) {
    job.throwIfStopped();

    const next = await deps.db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(STATEMENT_TIMEOUT);

        const terms = await personTerms(tx, payload);
        const after = current.cursor ? new Date(current.cursor) : new Date(0);
        const [chunk] = await tx.$queryRaw<Array<{ upto: Date | null }>>`
          SELECT max("created_at") AS "upto" FROM (
            SELECT "created_at" FROM "activity"
            WHERE "businessId" = ${payload.businessId}
              AND "created_at" > ${after}
            ORDER BY "created_at"
            LIMIT ${ACTIVITY_CHUNK}
          ) AS chunk
        `;

        if (!terms || !chunk?.upto) {
          const done = { ...current, phase: "identity" as const, cursor: "" };

          await job.checkpoint(done, tx);

          return done;
        }

        const patterns = [
          ...terms.names.map((name) => ({
            pattern: `\\m${regexLiteral(name)}\\M`,
            replacement: label,
          })),
          ...terms.secrets.map((secret) => ({
            pattern: regexLiteral(secret),
            replacement: "***",
          })),
        ];

        let description = Prisma.sql`"description"`;

        for (const { pattern, replacement } of patterns) {
          description = Prisma.sql`regexp_replace(${description}, ${pattern}, ${replacement}, 'gi')`;
        }

        const any = patterns.map(({ pattern }) => pattern).join("|");

        if (patterns.length > 0) {
          await tx.$executeRaw`
          UPDATE "activity"
          SET "description" = ${description}
          WHERE "businessId" = ${payload.businessId}
            AND "created_at" > ${after} AND "created_at" <= ${chunk.upto}
            AND "description" ~* ${any}
        `;
        }

        const moved = { ...current, cursor: chunk.upto.toISOString() };

        await job.checkpoint(moved, tx);

        return moved;
      },
      { timeout: TRANSACTION_MS, maxWait: TRANSACTION_MS },
    );

    current = next;

    if (current.phase !== "activities") return current;
  }
}

/** The login's personal data, and everything that lets it sign in. */
async function anonymizeLogin(
  tx: Tx,
  userId: string,
  email: string | null,
  label: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "user"
    SET "name" = ${label},
        "email" = NULL,
        "email_verified" = NULL,
        "avatar" = NULL,
        "whatsapp_phone" = NULL,
        "whatsapp_notifications_enabled" = false,
        "email_notifications_enabled" = false,
        "activity_notifications_enabled" = false,
        "two_factor_enabled" = false,
        "access_revoked" = true,
        "session_version" = "session_version" + 1,
        "last_seen_at" = NULL,
        "anonymized_at" = coalesce("anonymized_at", now()),
        "updated_at" = now()
    WHERE "id" = ${userId}
  `;

  await tx.$executeRaw`DELETE FROM "refresh_token" WHERE "userId" = ${userId}`;
  await tx.$executeRaw`DELETE FROM "push_device_token" WHERE "userId" = ${userId}`;
  await tx.$executeRaw`DELETE FROM "two_factor_confirmation" WHERE "userId" = ${userId}`;
  await tx.$executeRaw`DELETE FROM "driver_trusted_device" WHERE "userId" = ${userId}`;
  await tx.$executeRaw`DELETE FROM "driver_enrollment_token" WHERE "userId" = ${userId}`;
  await tx.$executeRaw`DELETE FROM "notification_preference" WHERE "userId" = ${userId}`;
  await tx.$executeRaw`DELETE FROM "pending_deletion" WHERE "userId" = ${userId}`;

  if (email) {
    await tx.$executeRaw`DELETE FROM "email_verification_token" WHERE "email" = ${email}`;
    await tx.$executeRaw`DELETE FROM "forgot_password_verification_token" WHERE "email" = ${email}`;
    await tx.$executeRaw`DELETE FROM "two_factor_token" WHERE "email" = ${email}`;
  }

  // The bell and the deliveries addressed to the person, with their
  // receipts: an inbox is the person's.
  await deleteQueueRowsOfUser(tx, userId);
}

/** The driver's personal data: what stays is the row the history needs. */
async function anonymizeDriver(
  tx: Tx,
  driverId: string,
  businessId: string,
): Promise<void> {
  // CPF and CNH are unique per company: each anonymized driver gets its
  // own placeholder, which no real document can ever match.
  const placeholder = `removido:${driverId}`;

  await tx.$executeRaw`
    UPDATE "driver"
    SET "name" = ${DRIVER_LABEL},
        "cpf" = ${placeholder},
        "cnh" = ${placeholder},
        "rg" = '',
        "birth_date" = '1900-01-01',
        "cnh_category" = NULL,
        "cnh_expires_at" = NULL,
        "cep" = '',
        "city" = '',
        "uf" = '',
        "street" = '',
        "address_number" = '',
        "complement" = NULL,
        "status" = 'INACTIVE'::"DriverStatus",
        "anonymized_at" = coalesce("anonymized_at", now()),
        "updated_at" = now()
    WHERE "id" = ${driverId}
  `;

  await tx.$executeRaw`DELETE FROM "driver_last_position" WHERE "driverId" = ${driverId}`;

  // The archived trail keeps the driver's days until they expire: a restore
  // leaves them out (trail-archive.ts, withoutRedactedDrivers).
  await tx.$executeRaw`
    INSERT INTO "trail_archive_redaction" ("driverId", "businessId")
    VALUES (${driverId}, ${businessId})
    ON CONFLICT ("driverId") DO NOTHING
  `;
}

/**
 * Phase 1, in one transaction with the next cursor. Answers null when the
 * subject is gone (or not the company's): nothing to do.
 */
async function anonymizeIdentity(
  deps: UserAnonymizeDeps,
  job: JobContext,
  payload: AnonymizePayload,
  progress: AnonymizeProgress,
): Promise<AnonymizeProgress | null> {
  return deps.db.$transaction(
    async (tx) => {
      const subject = await lockSubject(tx, payload);

      if (!subject) return null;

      if (subject.driverId) {
        await anonymizeDriver(tx, subject.driverId, payload.businessId);
      }

      if (subject.userId) {
        await anonymizeLogin(
          tx,
          subject.userId,
          subject.email,
          subject.driverId ? DRIVER_LABEL : USER_LABEL,
        );
      }

      const who = subject.driverId ? "Motorista" : "Usuário";

      await deps.activities().createActivityIfEnabled(
        {
          type: subject.driverId ? "Motorista" : "Usuário",
          action: "update",
          entityId: payload.subjectId,
          description: `${who} removido e anonimizado: os dados pessoais foram apagados e o histórico ficou com um autor anônimo`,
          status: "Anonimizado",
          performedBy: payload.requestedById,
          businessId: payload.businessId,
        },
        tx,
      );

      const next: AnonymizeProgress = {
        ...progress,
        phase: "avatar",
        driverId: subject.driverId,
        userId: subject.userId,
        table: 0,
        cursor: "",
      };

      await job.checkpoint(next, tx);

      return next;
    },
    { timeout: TRANSACTION_MS, maxWait: TRANSACTION_MS },
  );
}

/** Phase 2: the login's photos in the uploads bucket, a page at a time. */
async function removeAvatar(
  deps: UserAnonymizeDeps,
  job: JobContext,
  progress: AnonymizeProgress,
): Promise<AnonymizeProgress> {
  if (!progress.userId) return { ...progress, phase: "trail", cursor: "" };

  const uploads = deps.uploads();
  const prefix = `avatars/${progress.userId}/`;
  let current = progress;

  for (;;) {
    job.throwIfStopped();

    const keys = (
      await uploads.listObjectKeys(
        prefix,
        current.cursor || undefined,
        AVATAR_PAGE,
      )
    ).filter((key) => key.startsWith(prefix));
    let removed = 0;

    for (const key of keys) {
      const outcome = await uploads.deleteFileOutcome(key);

      if (outcome === "failed") {
        throw new Error(`anonimização: a foto ${key} não pôde ser apagada`);
      }

      if (outcome === "deleted") removed += 1;
    }

    current = {
      ...current,
      objects: current.objects + removed,
      cursor: keys.length > 0 ? keys[keys.length - 1] : current.cursor,
    };

    if (keys.length < AVATAR_PAGE) break;

    await job.checkpoint(current);
  }

  return { ...current, phase: "trail", table: 0, cursor: "" };
}

/** Whether a table exists (the delivery trail's shell may not). */
async function tableExists(
  deps: UserAnonymizeDeps,
  table: string,
): Promise<boolean> {
  const [row] = await deps.batch.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass(quote_ident(${table})) IS NOT NULL AS "present"
  `;

  return row?.present === true;
}

/** One short transaction of the maintenance pool, with the next cursor. */
async function batchTransaction<T>(
  deps: UserAnonymizeDeps,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return deps.batch.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(STATEMENT_TIMEOUT);

      return work(tx);
    },
    { timeout: TRANSACTION_MS, maxWait: TRANSACTION_MS },
  );
}

/** Phase 3: the driver's hot trail, by its primary key. */
async function removeTrail(
  deps: UserAnonymizeDeps,
  job: JobContext,
  progress: AnonymizeProgress,
): Promise<AnonymizeProgress> {
  let current = progress;

  while (current.driverId && current.table < TRAIL_TABLES.length) {
    job.throwIfStopped();

    const { table } = TRAIL_TABLES[current.table];
    const driverId = current.driverId;

    current = await batchTransaction(deps, async (tx) => {
      const deleted =
        table === "driver_position_v2"
          ? await tx.$executeRaw`
              DELETE FROM "driver_position_v2"
              WHERE ("driverId", "recorded_at") IN (
                SELECT "driverId", "recorded_at" FROM "driver_position_v2"
                WHERE "driverId" = ${driverId}::uuid
                LIMIT ${TRAIL_BATCH}
              )
            `
          : await tx.$executeRaw`
              DELETE FROM "driver_position"
              WHERE ("id", "recorded_at") IN (
                SELECT "id", "recorded_at" FROM "driver_position"
                WHERE "driverId" = ${driverId}
                LIMIT ${TRAIL_BATCH}
              )
            `;
      const next: AnonymizeProgress = {
        ...current,
        trailRows: current.trailRows + deleted,
        table: deleted < TRAIL_BATCH ? current.table + 1 : current.table,
      };

      await job.checkpoint(next, tx);

      return next;
    });
  }

  return { ...current, phase: "events", table: 0, cursor: "" };
}

/**
 * Phase 4: the phone on the delivery events the login reported, one chunk
 * of the company's events at a time (no index by reporter: a walk of the
 * company's own index, once).
 */
async function removeEventDevices(
  deps: UserAnonymizeDeps,
  job: JobContext,
  businessId: string,
  progress: AnonymizeProgress,
): Promise<AnonymizeProgress> {
  let current = progress;

  while (current.userId && current.table < EVENT_TABLES.length) {
    job.throwIfStopped();

    const table = EVENT_TABLES[current.table];

    if (current.cursor === "" && !(await tableExists(deps, table))) {
      current = { ...current, table: current.table + 1, cursor: "" };
      continue;
    }

    const userId = current.userId;

    current = await batchTransaction(deps, async (tx) => {
      const [chunk] =
        table === "delivery_event"
          ? await tx.$queryRaw<Array<{ upto: string | null }>>`
              SELECT max("id")::text AS "upto" FROM (
                SELECT "id" FROM "delivery_event"
                WHERE "businessId" = ${businessId} AND "id" > ${current.cursor}
                ORDER BY "id" LIMIT ${EVENT_CHUNK}
              ) AS chunk
            `
          : await tx.$queryRaw<Array<{ upto: string | null }>>`
              SELECT max("id")::text AS "upto" FROM (
                SELECT "id" FROM "delivery_event_part"
                WHERE "businessId" = ${businessId} AND "id" > ${current.cursor}
                ORDER BY "id" LIMIT ${EVENT_CHUNK}
              ) AS chunk
            `;

      if (!chunk?.upto) {
        const next = { ...current, table: current.table + 1, cursor: "" };

        await job.checkpoint(next, tx);

        return next;
      }

      const cleared =
        table === "delivery_event"
          ? await tx.$executeRaw`
              UPDATE "delivery_event"
              SET "device" = NULL, "device_id" = NULL
              WHERE "businessId" = ${businessId}
                AND "id" > ${current.cursor} AND "id" <= ${chunk.upto}
                AND "reportedById" = ${userId}
                AND ("device" IS NOT NULL OR "device_id" IS NOT NULL)
            `
          : await tx.$executeRaw`
              UPDATE "delivery_event_part"
              SET "device" = NULL, "device_id" = NULL
              WHERE "businessId" = ${businessId}
                AND "id" > ${current.cursor} AND "id" <= ${chunk.upto}
                AND "reportedById" = ${userId}
                AND ("device" IS NOT NULL OR "device_id" IS NOT NULL)
            `;
      const next = {
        ...current,
        events: current.events + cleared,
        cursor: chunk.upto,
      };

      await job.checkpoint(next, tx);

      return next;
    });
  }

  return { ...current, phase: "done", cursor: "" };
}

function createUserAnonymizeJob(deps: UserAnonymizeDeps): JobHandler {
  return {
    async run(job) {
      const payload = payloadOf(job);
      let progress = progressOf(job.progress);

      if (progress.phase === "activities") {
        progress = await scrubActivities(deps, job, payload, progress);
      }

      if (progress.phase === "identity") {
        const next = await anonymizeIdentity(deps, job, payload, progress);

        if (!next) {
          log.info(
            { jobId: job.id, subject: payload.subject },
            "subject of the anonymization is gone; nothing to do",
          );
          return;
        }

        progress = next;

        // After the commit, never inside it: the driver is INACTIVE and
        // "Motorista removido" now, and the open pickers (web selectors, the
        // app's driver list) trust catalogChanged to say so. A login without
        // a driver is in no catalogue. A crash between the commit and here
        // loses the hint, as any lost hint does: the next refetch is right.
        if (next.driverId) {
          sendCatalogChangedEvent(payload.businessId, "driver");
        }
      }

      if (progress.phase === "avatar") {
        progress = await removeAvatar(deps, job, progress);
        await job.checkpoint(progress);
      }

      if (progress.phase === "trail") {
        progress = await removeTrail(deps, job, progress);
        await job.checkpoint(progress);
      }

      if (progress.phase === "events") {
        progress = await removeEventDevices(
          deps,
          job,
          payload.businessId,
          progress,
        );
        await job.checkpoint(progress);
      }

      log.info(
        {
          jobId: job.id,
          subject: payload.subject,
          trailRows: progress.trailRows,
          events: progress.events,
          objects: progress.objects,
        },
        "person removed and anonymized",
      );
    },
  };
}

/** The job as the runner registers it. */
const userAnonymizeJob: JobHandler = createUserAnonymizeJob({
  db: database,
  batch: databaseBatch,
  uploads: () => container.resolve<UploadService>("UploadService"),
  activities: () =>
    container.resolve<NotificationService>("NotificationService"),
});

export { DRIVER_LABEL, USER_LABEL, createUserAnonymizeJob, userAnonymizeJob };
export type {
  AnonymizePayload,
  AnonymizeProgress,
  AnonymizeSubject,
  UserAnonymizeDeps,
};
