import database from "@/../infra/database";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import type { AIAnalysisRequestInput } from "@/shared/ai/ai-types";

const log = logger.child({
  component: "cron",
  job: "reconcile-record-analysis",
});

/**
 * How long a record waits before the sweep considers its request lost. The
 * same reasoning as the proof sweep (reconcile-proof-analysis-job): a younger
 * record may still be waiting for its own post-commit call.
 */
const SETTLE_MS = 10 * 60 * 1000;

/**
 * How far back the sweep looks: a reading days after the fuelling or the
 * inspection is a reading nobody acts on, and the bound keeps every run a
 * short range of the (businessId, created_at) indexes.
 */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/** Per company and per run, so one company's backlog cannot fill a run. */
const PER_COMPANY_LIMIT = 50;
const PER_RUN_LIMIT = 200;

interface LostRecord {
  id: string;
  businessId: string;
  requestedById: string;
}

/**
 * The fuel and checklist readings whose request was never made — the gap the
 * proof already closed with its own sweep (IDEMP-08).
 *
 * The fuelling and the checklist ask for their AI reading after their
 * commit, fire-and-forget, because the driver must never lose a record over a
 * hint for the office. That makes the request at-most-once: a crash, a deploy
 * or a pool timeout between the commit and requestAnalysis leaves the record
 * "pending" for good, and the app's resend cannot heal it — a known
 * submission returns before any side effect. Only the manual "Verificar com
 * IA" button got it out.
 *
 * This asks again for a record that is:
 *  - still `pending` (the column's default: no request ever moved it — a
 *    request marks it analysing, skipped or a verdict);
 *  - between LOOKBACK_MS and SETTLE_MS old, with a photo to read (a
 *    checklist whose field lists are all empty has none: the service answers
 *    "unavailable" without marking it, so it used to be picked again every
 *    run, taking its company's slots for two days);
 *  - of a company with the reading on now (ai_analysis_limit > 0) AND
 *    already reading when the record was made — it had a quota period
 *    opened before it. Without this, switching the reading on would spend
 *    the fresh quota on the last two days of records created while it was
 *    off, which the manual button's design rules out on purpose;
 *  - not made before the reading was last switched back on: a period from
 *    an earlier month says nothing about a company that turned it off and
 *    on again since. The switch is the `business-limit.changed` outbox event
 *    from 0 (update-ai-limit-usecase), kept 30 days, which covers the two
 *    days looked at here;
 *  - without any AI request of its type (type, recordId index);
 *  - with a driver who has a login: the request is attributed to a user
 *    (requestedById feeds the activity trail), and the driver is who sent it.
 *
 * The input is built from the stored row exactly as the manual button builds
 * it (request-record-analysis-usecase), so requestAnalysis decides coverage,
 * quota (reserved once, by the idempotency key) and the "skipped" marks the
 * way it always does. A record it marks skipped or queues is no longer
 * "pending without a request", so it is never asked twice.
 *
 * An UPDATE whose re-verification was lost is not found here: an update does
 * not reset the status to pending. The manual button covers that case.
 *
 * Per company through a LATERAL, statuses as SQL literals, like the proof
 * sweep, and the run takes the oldest records first across companies: with
 * no order the PER_RUN_LIMIT cut fell wherever the scan put it, and the same
 * few companies could fill every run. Cron: every 10 minutes, offset by 5
 * from the proof sweep, on one replica (the scheduler's election).
 */
const reconcileRecordAnalysisJob: CronJobDefinition = {
  name: "reconcile-record-analysis",
  schedule: "5,15,25,35,45,55 * * * *",

  async handler() {
    // Without a provider every request is only marked unavailable (dev).
    if (!aiProviderConfigured()) return;

    const settledBefore = new Date(Date.now() - SETTLE_MS);
    const since = new Date(Date.now() - LOOKBACK_MS);

    const fuels = await database.$queryRaw<LostRecord[]>`
      SELECT lost."id", lost."businessId", lost."requestedById"
      FROM "business" b
      CROSS JOIN LATERAL (
        SELECT
          f."id",
          f."businessId",
          u."id" AS "requestedById",
          f."created_at"
        FROM "fuel" f
        JOIN "user" u ON u."driverId" = f."driverId"
        WHERE f."businessId" = b."id"
          AND f."created_at" >= ${since}
          AND f."created_at" < ${settledBefore}
          AND f."odometer_ai_status" = 'pending'
          AND f."odometer_photo" <> ''
          AND EXISTS (
            SELECT 1
            FROM "ai_usage_period" p
            WHERE p."businessId" = b."id"
              AND p."created_at" <= f."created_at"
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "domain_outbox_event" e
            WHERE e."aggregateType" = 'business'
              AND e."aggregateId" = b."id"
              AND e."topic" = 'business-limit.changed'
              AND e."created_at" > f."created_at"
              AND e."payload"->>'limit' = 'ai'
              AND e."payload"->'previousValue' = '0'::jsonb
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "ai_analysis_request" r
            WHERE r."type" = 'FUEL_ODOMETER'
              AND r."recordId" = f."id"
          )
        ORDER BY f."created_at"
        LIMIT ${PER_COMPANY_LIMIT}::int
      ) lost
      WHERE b."ai_analysis_limit" > 0
      ORDER BY lost."created_at", lost."id"
      LIMIT ${PER_RUN_LIMIT}::int
    `;

    const checklists = await database.$queryRaw<LostRecord[]>`
      SELECT lost."id", lost."businessId", lost."requestedById"
      FROM "business" b
      CROSS JOIN LATERAL (
        SELECT
          c."id",
          c."businessId",
          u."id" AS "requestedById",
          c."created_at"
        FROM "vehicle_checklist" c
        JOIN "user" u ON u."driverId" = c."driverId"
        WHERE c."businessId" = b."id"
          AND c."created_at" >= ${since}
          AND c."created_at" < ${settledBefore}
          AND c."ai_verification_status" = 'pending'
          -- A photo the service can read: some field whose list starts
          -- with a path, as buildAnalysisUnits counts them. A record of
          -- empty lists only is answered unavailable and never marked, so
          -- it came back every run and held the slots of its company.
          -- jsonb_each refuses a non-object, hence the CASE.
          AND CASE
            WHEN jsonb_typeof(c."photos_by_field") = 'object' THEN EXISTS (
              SELECT 1
              FROM jsonb_each(c."photos_by_field") AS field(name, photos)
              WHERE jsonb_typeof(field.photos) = 'array'
                AND jsonb_typeof(field.photos -> 0) = 'string'
                AND field.photos ->> 0 <> ''
            )
            ELSE false
          END
          AND EXISTS (
            SELECT 1
            FROM "ai_usage_period" p
            WHERE p."businessId" = b."id"
              AND p."created_at" <= c."created_at"
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "domain_outbox_event" e
            WHERE e."aggregateType" = 'business'
              AND e."aggregateId" = b."id"
              AND e."topic" = 'business-limit.changed'
              AND e."created_at" > c."created_at"
              AND e."payload"->>'limit' = 'ai'
              AND e."payload"->'previousValue' = '0'::jsonb
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "ai_analysis_request" r
            WHERE r."type" = 'CHECKLIST'
              AND r."recordId" = c."id"
          )
        ORDER BY c."created_at"
        LIMIT ${PER_COMPANY_LIMIT}::int
      ) lost
      WHERE b."ai_analysis_limit" > 0
      ORDER BY lost."created_at", lost."id"
      LIMIT ${PER_RUN_LIMIT}::int
    `;

    let requested = 0;

    for (const fuel of fuels) {
      if (await requestAgain(() => fuelInput(fuel), fuel.id)) requested += 1;
    }

    for (const checklist of checklists) {
      if (await requestAgain(() => checklistInput(checklist), checklist.id)) {
        requested += 1;
      }
    }

    const found = fuels.length + checklists.length;

    if (found > 0) {
      log.info(
        {
          found,
          fuels: fuels.length,
          checklists: checklists.length,
          requested,
        },
        "AI readings requested for records left without one",
      );
    }
  },
};

/** One record never sinks the sweep; the next run tries it again. */
async function requestAgain(
  build: () => Promise<AIAnalysisRequestInput | null>,
  recordId: string,
): Promise<boolean> {
  try {
    const input = await build();

    if (!input) return false;

    await AIAnalysisService.getInstance().requestAnalysis(input);

    return true;
  } catch (error) {
    log.warn(
      { err: error, recordId },
      "could not request the missing AI reading",
    );

    return false;
  }
}

/** The fuelling's request, as the create use case and the button build it. */
async function fuelInput(
  lost: LostRecord,
): Promise<AIAnalysisRequestInput | null> {
  const fuel = await database.fuel.findFirst({
    where: { id: lost.id, businessId: lost.businessId },
    select: { odometer_photo: true, current_mileage: true },
  });

  if (!fuel?.odometer_photo) return null;

  return {
    type: "FUEL_ODOMETER",
    recordId: lost.id,
    businessId: lost.businessId,
    requestedById: lost.requestedById,
    input: {
      odometerPhotoPath: fuel.odometer_photo,
      reportedMileage: fuel.current_mileage,
    },
  };
}

/**
 * The checklist's request: every photographed field and the row's values.
 * The service keeps only the photographed fields' values and reads only the
 * photos its reader covers (normalizedRequest, buildAnalysisUnits).
 */
async function checklistInput(
  lost: LostRecord,
): Promise<AIAnalysisRequestInput | null> {
  const checklist = await database.vehicleChecklist.findFirst({
    where: { id: lost.id, businessId: lost.businessId },
  });

  const photosByField =
    (checklist?.photos_by_field as Record<string, string[]> | null) ?? {};

  if (!checklist || Object.keys(photosByField).length === 0) return null;

  return {
    type: "CHECKLIST",
    recordId: lost.id,
    businessId: lost.businessId,
    requestedById: lost.requestedById,
    input: {
      photosByField,
      checklistData: checklist as unknown as Record<string, unknown>,
    },
  };
}

export { reconcileRecordAnalysisJob };
