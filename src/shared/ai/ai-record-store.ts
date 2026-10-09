import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import {
  odometerDeviceAgreement,
  proofDeviceAgreement,
  type DeviceAgreement,
} from "@/shared/ai-precheck/device-precheck";

import {
  ChecklistFieldOutcome,
  mergeChecklistResults,
  odometerReadingMatches,
  reassessChecklistField,
} from "./ai-rules";
import type {
  ChecklistAnalysisInput,
  FuelOdometerAnalysisInput,
  OdometerUnitResult,
} from "./ai-types";

/**
 * Writers for the AI verdict fields on the business records (Fuel,
 * VehicleChecklist, the proof's review card). Both the request service (skip
 * marking) and the pipeline (progress + results) go through here so the field
 * semantics live in one place.
 *
 * Every pipeline write is FENCED by the input the request read (AI-4). The
 * pipeline's own fencing protects the request row; it said nothing about the
 * record. A request for a photo the user has since replaced — or a mileage
 * since edited, or a receipt proven again — answered after the newer
 * request and wrote the old photo's verdict over the new one. A write whose
 * input is no longer the record's matches nothing, and the caller learns it.
 */

/** The checklist field whose photo is the odometer (the mileage pre-check's). */
const MILEAGE_FIELD = "current_mileage";

/** The fuel row still holds the photo and mileage this request read. */
function fuelInputFence(recordId: string, input: FuelOdometerAnalysisInput) {
  return {
    id: recordId,
    odometer_photo: input.odometerPhotoPath,
    current_mileage: input.reportedMileage,
  };
}

/** False when the record moved on (or is gone): the analysis is moot. */
async function markFuelAnalyzing(
  recordId: string,
  input: FuelOdometerAnalysisInput,
): Promise<boolean> {
  const marked = await database.fuel.updateMany({
    where: fuelInputFence(recordId, input),
    data: { odometer_ai_status: "analyzing" },
  });

  return marked.count === 1;
}

async function markFuelSkipped(recordId: string): Promise<void> {
  await database.fuel.update({
    where: { id: recordId },
    data: {
      odometer_ai_status: "skipped",
      odometer_ai_analyzed_at: new Date(),
    },
  });
}

async function markFuelError(
  recordId: string,
  input: FuelOdometerAnalysisInput,
): Promise<boolean> {
  const marked = await database.fuel.updateMany({
    where: fuelInputFence(recordId, input),
    data: {
      odometer_ai_status: "error",
      odometer_ai_analyzed_at: new Date(),
    },
  });

  return marked.count === 1;
}

/**
 * What the screens read from Fuel.odometer_ai_details: the normalized result,
 * not the model's raw answer, whose key was `confianca` on a 0–100 scale — so
 * the badge showed "8500%" live and vanished after a refresh (AI-3).
 */
function fuelDetails(result: OdometerUnitResult) {
  return {
    confidence: result.confidence,
    readMileage: result.readMileage,
    reportedMileage: result.reportedMileage,
    observation: result.observation,
    details: result.details,
    fraudReasons: result.fraudReasons,
    // The screens tell "km confere" from "verificado" by this (ADR 0010).
    ...(result.fraudAssessed === false ? { fraudAssessed: false } : {}),
  };
}

interface FuelResultWrite {
  /** False when the record no longer holds the input this result is about. */
  written: boolean;

  /** The phone's odometer pre-check against this reading; null when none. */
  deviceAgreement: DeviceAgreement | null;
}

async function writeFuelResult(
  recordId: string,
  input: FuelOdometerAnalysisInput,
  result: OdometerUnitResult,
): Promise<FuelResultWrite> {
  return database.$transaction(async (tx) => {
    // Under the row's lock: the pre-check read is the one the verdict is
    // written beside.
    const [row] = await tx.$queryRaw<Array<{ odometer_device_precheck: unknown }>>`
      SELECT "odometer_device_precheck"
      FROM "fuel"
      WHERE "id" = ${recordId}
        AND "odometer_photo" = ${input.odometerPhotoPath}
        AND "current_mileage" = ${input.reportedMileage}
      FOR UPDATE
    `;

    if (!row) return { written: false, deviceAgreement: null };

    const deviceAgreement = odometerDeviceAgreement(
      row.odometer_device_precheck,
      odometerReadingMatches(result.readMileage, input.reportedMileage),
    );

    const written = await tx.fuel.updateMany({
      where: fuelInputFence(recordId, input),
      data: {
        odometer_ai_reading: result.readMileage,
        odometer_ai_status: result.status,
        odometer_ai_details: fuelDetails(result) as Prisma.InputJsonValue,
        odometer_ai_analyzed_at: new Date(),
        // The seal needs the fraud judged: a reader that cannot tell a photo
        // of a screen from a dashboard (OCR) only says the km matches.
        odometer_verified:
          result.status === "verified" && result.fraudAssessed !== false,
        // Beside the device's JSON, never inside it (design §P5.2).
        ...(deviceAgreement && { odometer_device_agreement: deviceAgreement }),
      },
    });

    return { written: written.count === 1, deviceAgreement };
  });
}

/** The first photo of each field, as the record stores it. */
function primaryPhotos(value: unknown): Record<string, string | undefined> {
  const byField =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    Object.entries(byField).map(([field, photos]) => [
      field,
      Array.isArray(photos) && typeof photos[0] === "string"
        ? photos[0]
        : undefined,
    ]),
  );
}

/** The fields of the request whose photo is still the record's. */
function currentFields(
  requestPhotos: ChecklistAnalysisInput["photosByField"],
  recordPhotos: unknown,
): Set<string> {
  const onRecord = primaryPhotos(recordPhotos);

  return new Set(
    Object.entries(requestPhotos)
      .filter(([field, photos]) => photos?.[0] && onRecord[field] === photos[0])
      .map(([field]) => field),
  );
}

/**
 * The request's fields whose photo is still on the record; the record is
 * marked "analyzing" only when there is at least one. Empty: every photo was
 * replaced (or the record is gone), and the analysis is moot.
 */
async function markChecklistAnalyzing(
  recordId: string,
  photosByField: ChecklistAnalysisInput["photosByField"],
): Promise<Set<string>> {
  const row = await database.vehicleChecklist.findUnique({
    where: { id: recordId },
    select: { photos_by_field: true },
  });

  const current = row
    ? currentFields(photosByField, row.photos_by_field)
    : new Set<string>();

  if (current.size > 0) {
    await database.vehicleChecklist.updateMany({
      where: { id: recordId },
      data: { ai_verification_status: "analyzing" },
    });
  }

  return current;
}

async function markChecklistSkipped(recordId: string): Promise<void> {
  await database.vehicleChecklist.update({
    where: { id: recordId },
    data: {
      ai_verification_status: "skipped",
      ai_verified_at: new Date(),
    },
  });
}

function parseDetails(value: unknown): Record<string, ChecklistFieldOutcome> {
  if (!value) return {};

  // Older rows stored the JSON as a string.
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, ChecklistFieldOutcome>;
    } catch {
      return {};
    }
  }

  return value as Record<string, ChecklistFieldOutcome>;
}

/** A field's result as the record keeps it: no raw model answer. */
function storedOutcome(outcome: ChecklistFieldOutcome): ChecklistFieldOutcome {
  const { rawResponse: _raw, ...kept } = outcome;
  return kept as ChecklistFieldOutcome;
}

interface ChecklistVerdict {
  /** False when no field of the request is still on the record. */
  written: boolean;
  merged: Record<string, ChecklistFieldOutcome>;
  overallStatus: "verified" | "issues_found" | "error";

  /**
   * The phone's mileage pre-check against this request's current_mileage
   * reading; null when either is missing.
   */
  deviceAgreement?: DeviceAgreement | null;
}

/**
 * Merges this request's field results into the record, keeping only the
 * fields whose photo the record still holds, and recomputes the overall
 * status — under the row's lock, so a newer request writing the same record
 * at the same moment is serialized with this one instead of interleaved.
 */
async function writeChecklistVerdict(
  recordId: string,
  photosByField: ChecklistAnalysisInput["photosByField"],
  fresh: Record<string, ChecklistFieldOutcome>,
): Promise<ChecklistVerdict> {
  return database.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{
        photos_by_field: unknown;
        ai_verification_details: unknown;
        mileage_device_precheck: unknown;
      }>
    >`
      SELECT "photos_by_field", "ai_verification_details", "mileage_device_precheck"
      FROM "vehicle_checklist"
      WHERE "id" = ${recordId}
      FOR UPDATE
    `;

    const existing = parseDetails(row?.ai_verification_details);

    if (!row) {
      return { written: false, ...mergeChecklistResults(existing, {}) };
    }

    const current = currentFields(photosByField, row.photos_by_field);

    if (current.size === 0) {
      return { written: false, ...mergeChecklistResults(existing, {}) };
    }

    const applicable = Object.fromEntries(
      Object.entries(fresh)
        .filter(([field]) => current.has(field))
        .map(([field, outcome]) => [field, storedOutcome(outcome)]),
    );

    const { merged, overallStatus } = mergeChecklistResults(existing, applicable);

    // Only when THIS request read the odometer photo the record still holds
    // (design §P5.2): beside the device's JSON, never inside it.
    const mileage = applicable[MILEAGE_FIELD];
    const deviceAgreement = mileage
      ? odometerDeviceAgreement(
          row.mileage_device_precheck,
          odometerReadingMatches(mileage.observed, mileage.informed),
        )
      : null;

    await tx.vehicleChecklist.update({
      where: { id: recordId },
      data: {
        ai_verification_status: overallStatus,
        ai_verification_details: merged as unknown as Prisma.InputJsonValue,
        ai_verified_at: new Date(),
        ...(deviceAgreement && { mileage_device_agreement: deviceAgreement }),
      },
    });

    return { written: true, merged, overallStatus, deviceAgreement };
  });
}

/**
 * The statuses that ARE a verdict. Any other — a reading under way, a newer
 * photo skipped by the quota, a failure — says something the re-comparison
 * does not know about, and stays.
 */
const VERDICT_STATUSES = new Set(["verified", "issues_found"]);

interface RefreshedChecklistVerdict extends ChecklistVerdict {
  /** The fields whose outcome changed against the values held now. */
  changed: string[];
}

/**
 * Compares the checklist's PAID readings again with the values it holds now,
 * and rewrites the verdict when an outcome changed — no provider call, no
 * quota.
 *
 * With blind reading the verdict is the comparison of what the model saw with
 * what was informed, made when the reading was written. A manager who
 * corrected an informed condition after the AI flagged it — the reason the
 * flag exists — kept "Não confere" on a field that now agrees with its photo:
 * the update queues a reading only for a new photo, and the photo already
 * read is never paid for again. Only the reading of the photo each field
 * holds now counts; a field whose photo changed waits for its own request.
 *
 * Under the row's lock, like writeChecklistVerdict. The overall status is
 * rewritten only over a verdict: while a reading is under way it stays
 * "analyzing" (that request's verdict, merged over these details, is the one
 * to show), and a "skipped" or "error" about a newer photo stays true.
 */
async function refreshChecklistVerdict(
  recordId: string,
): Promise<RefreshedChecklistVerdict | null> {
  return database.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "vehicle_checklist" WHERE "id" = ${recordId} FOR UPDATE
    `;

    if (locked.length === 0) return null;

    const row = await tx.vehicleChecklist.findUniqueOrThrow({
      where: { id: recordId },
    });

    const existing = parseDetails(row.ai_verification_details);
    const fields = Object.keys(existing);

    if (fields.length === 0) return null;

    const onRecord = primaryPhotos(row.photos_by_field);

    const paid = await tx.$queryRaw<
      Array<{ unitKey: string; photo: string | null; result: unknown }>
    >`
      SELECT u."unitKey",
             r."input"->'photosByField'->u."unitKey"->>0 AS "photo",
             u."result"
      FROM "ai_analysis_unit" u
      JOIN "ai_analysis_request" r ON r."id" = u."requestId"
      WHERE r."type" = 'CHECKLIST'
        AND r."recordId" = ${recordId}
        AND r."businessId" = ${row.businessId}
        AND u."status" = 'CONSUMED'
        AND u."unitKey" IN (${Prisma.join(fields)})
      ORDER BY u."consumedAt" DESC NULLS LAST, u."id" DESC
    `;

    const values = row as unknown as Record<string, unknown>;
    const fresh: Record<string, ChecklistFieldOutcome> = {};
    const changed: string[] = [];

    for (const field of fields) {
      // The latest reading of the photo the field holds now.
      const reading = paid.find(
        (unit) => unit.unitKey === field && unit.photo === onRecord[field],
      );

      const answer = (reading?.result as { rawResponse?: unknown } | null)
        ?.rawResponse;

      if (!reading || answer === undefined) continue;

      const reassessed = reassessChecklistField(field, answer, values[field]);
      if (!reassessed) continue;

      const outcome = storedOutcome(
        reassessed as unknown as ChecklistFieldOutcome,
      );
      const before = existing[field];

      if (
        before?.status !== outcome.status ||
        before?.informed !== outcome.informed ||
        before?.observation !== outcome.observation
      ) {
        fresh[field] = outcome;
        changed.push(field);
      }
    }

    const { merged, overallStatus } = mergeChecklistResults(existing, fresh);

    if (changed.length === 0) {
      return { written: false, merged, overallStatus, changed };
    }

    await tx.vehicleChecklist.update({
      where: { id: recordId },
      data: {
        ai_verification_details: merged as unknown as Prisma.InputJsonValue,
        ...(VERDICT_STATUSES.has(row.ai_verification_status ?? "")
          ? { ai_verification_status: overallStatus }
          : {}),
      },
    });

    return { written: true, merged, overallStatus, changed };
  });
}

/**
 * The card a receipt reading may land on: this company's, still PENDING — a
 * reviewer who decided while the model was thinking must not have their
 * verdict dragged back by a late answer — AND for the receipt this request
 * read: the delivery's latest proof photo must still be `photoPath`. A
 * re-proof reopens the same card for a new photo, and the reading of the old
 * one used to land on it (AI-4). One fence for the check before the call and
 * the write after it, so the two can never disagree.
 */
function proofCardFence(
  deliveryId: string,
  businessId: string,
  photoPath: string,
): Prisma.Sql {
  return Prisma.sql`
    card."deliveryId" = ${deliveryId}
      AND card."businessId" = ${businessId}
      AND card."status" = 'PENDING'
      AND (
        SELECT e."photo"
        FROM "delivery_event" AS e
        WHERE e."deliveryId" = card."deliveryId"
          AND e."type" = 'PROOF'
        ORDER BY e."created_at" DESC, e."id" DESC
        LIMIT 1
      ) = ${photoPath}
  `;
}

/**
 * Whether a reading of `photoPath` would still reach a card. False before the
 * provider is called means the reading is moot — re-proven, decided, or gone
 * — and nothing should be paid for it, as the fuel and checklist paths check
 * before theirs.
 */
async function proofCardAwaitsReading(
  deliveryId: string,
  businessId: string,
  photoPath: string,
): Promise<boolean> {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT card."id"
    FROM "delivery_proof_audit" AS card
    WHERE ${proofCardFence(deliveryId, businessId, photoPath)}
    LIMIT 1
  `;

  return rows.length > 0;
}

interface AttachedProofSuggestion {
  /** How many cards it wrote (0 or 1). */
  attached: number;

  /** The phone's pre-check against this reading; null when there was none. */
  deviceAgreement: DeviceAgreement | null;
}

/**
 * Writes what the model concluded onto the queue card a person will open,
 * under the fence above, with the device pre-check's agreement.
 */
async function attachProofSuggestion(
  deliveryId: string,
  businessId: string,
  photoPath: string,
  suggestion: unknown,
  confidence: number,
): Promise<AttachedProofSuggestion> {
  return database.$transaction(async (tx) => {
    // Timestamps as UTC wall time: the columns are timestamp WITHOUT zone, and
    // a bare now() would be read in the session's zone.
    const rows = await tx.$queryRaw<Array<{ id: string; device_precheck: unknown }>>`
      UPDATE "delivery_proof_audit" AS card
      SET "ai_suggestion" = ${JSON.stringify(suggestion)}::jsonb,
          "ai_confidence" = ${confidence},
          "ai_analyzed_at" = (now() AT TIME ZONE 'UTC'),
          "updated_at" = (now() AT TIME ZONE 'UTC')
      WHERE ${proofCardFence(deliveryId, businessId, photoPath)}
      RETURNING card."id", card."device_precheck"
    `;

    const [card] = rows;

    if (!card) return { attached: 0, deviceAgreement: null };

    // The phone's pre-check against this reading (design §P5.2), in its own
    // column beside the device's JSON, under the row lock the UPDATE holds.
    const reading = (suggestion as { reading?: { documentMatches?: unknown } | null } | null)
      ?.reading;
    const deviceAgreement = proofDeviceAgreement(card.device_precheck, reading);

    if (deviceAgreement) {
      await tx.$executeRaw`
        UPDATE "delivery_proof_audit"
        SET "device_agreement" = ${deviceAgreement}::"DeviceAgreement"
        WHERE "id" = ${card.id}
      `;
    }

    return { attached: rows.length, deviceAgreement };
  });
}

export {
  attachProofSuggestion,
  proofCardAwaitsReading,
  currentFields,
  fuelDetails,
  markChecklistAnalyzing,
  markChecklistSkipped,
  markFuelAnalyzing,
  markFuelError,
  markFuelSkipped,
  refreshChecklistVerdict,
  writeChecklistVerdict,
  writeFuelResult,
};
export type {
  AttachedProofSuggestion,
  ChecklistVerdict,
  FuelResultWrite,
  RefreshedChecklistVerdict,
};
