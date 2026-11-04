import { inject, injectable } from "tsyringe";
import { z } from "zod";

import type { IBusinessSettingsRepository } from "@/modules/business/repositories/IBusiness-settings-repository";
import { effectiveBusinessSettings } from "@/shared/business/business-settings";
import { parseInstant } from "@/shared/delivery/occurred-at";
import { AppError } from "@/shared/errors/AppError";

import {
  geofenceDecision,
  geofenceVerdict,
  isRecentSubmission,
  type AddressPrecision,
  type GeoPoint,
  type GeofenceAction,
  type GeofenceOutcome,
} from "./geofence-rules";

/**
 * The server's half of the geofence (plan of 02/11/2026, item E4): the one
 * place the arrival, the proof and the occurrence ask "was the driver at the
 * customer's address?". It reads the company's mode and radius (never
 * cached: a save on one replica holds on the next request anywhere), runs
 * the shared rule (geofence-rules.ts) and answers the record to store with
 * the event — or refuses, which only happens to a FRESH arrival or proof
 * outside the radius under BLOCK (decision D14). A replay never gets here:
 * every caller answers a resend before asking, so a stored verdict is never
 * re-decided under a radius changed since.
 */

/** What the event (and the occurrence) store about the geofence. */
interface GeofenceRecord {
  distance_m: number | null;
  accuracy_m: number | null;
  geofence_outcome: GeofenceOutcome;
}

/** The delivery's address point, as the row has it. */
interface GeofenceAddress {
  latitude?: number | null;
  longitude?: number | null;
  geo_source?: string | null;
  geo_precision?: string | null;
}

interface GeofenceCheckInput {
  businessId: string;
  /** The modules the company has on (the geofence needs DELIVERIES, M6). */
  enabledModules: readonly string[];
  action: GeofenceAction;
  address: GeofenceAddress;
  position: { latitude?: number | null; longitude?: number | null };
  /** The body's `accuracy`, read with readAccuracy. */
  accuracy: number | null;
  /** geofencePositionAgeMs of the request; null when unknown. */
  positionAgeMs: number | null;
  /** The resolved tap (resolveOccurredAt); null = made now. */
  occurredAt: Date | null;
  now?: Date;
}

/** A refusal only BLOCK gives, with its own code and the distance in words. */
class GeofenceRefusedError extends AppError {
  readonly distanceM: number;
  readonly radiusM: number;

  constructor(action: GeofenceAction, distanceM: number, radiusM: number) {
    const metres = (value: number) =>
      `${new Intl.NumberFormat("pt-BR").format(Math.round(value))} m`;
    const what =
      action === "PROOF" ? "comprovar a entrega" : "registrar a chegada";

    super(
      `Você está a ${metres(distanceM)} do endereço da entrega. A empresa só permite ${what} a até ${metres(radiusM)} do endereço.`,
      422,
      "ARRIVAL_OUTSIDE_GEOFENCE",
    );

    this.distanceM = distanceM;
    this.radiusM = radiusM;
  }
}

/** A point only when both coordinates are numbers. */
function pointOf(value: {
  latitude?: number | null;
  longitude?: number | null;
}): GeoPoint | null {
  return typeof value.latitude === "number" &&
    typeof value.longitude === "number"
    ? { latitude: value.latitude, longitude: value.longitude }
    : null;
}

const ADDRESS_PRECISIONS: ReadonlySet<string> = new Set([
  "ADDRESS",
  "STREET",
  "NEIGHBORHOOD",
  "CITY",
]);

/**
 * The level of the address point: only a point the geocoder found has one
 * (item E1). A point the dispatcher pinned is exact, whatever a geocoder
 * wrote before it.
 */
function addressPrecisionOf(address: GeofenceAddress): AddressPrecision | null {
  return address.geo_source === "GEOCODER" &&
    typeof address.geo_precision === "string" &&
    ADDRESS_PRECISIONS.has(address.geo_precision)
    ? (address.geo_precision as AddressPrecision)
    : null;
}

/** The body's accuracy, in metres, or null for anything unusable. */
function readAccuracy(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * How old the fix was at the tap: the tap (`occurred_at`, or the send stamp
 * when the body has none) minus the fix's own stamp (`position_recorded_at`),
 * both read from the phone's clock — so a phone set to the wrong time costs
 * nothing, as in resolveOccurredAt. Null when either is missing or
 * unreadable; never negative.
 */
function geofencePositionAgeMs(input: {
  tappedAt: unknown;
  sentAt?: unknown;
  positionRecordedAt: unknown;
}): number | null {
  const fix = parseInstant(input.positionRecordedAt);
  const tap = parseInstant(input.tappedAt) ?? parseInstant(input.sentAt);

  if (fix === null || tap === null) return null;

  return Math.max(0, tap - fix);
}

@injectable()
class GeofenceCheck {
  constructor(
    @inject("BusinessSettingsRepository")
    private settings: IBusinessSettingsRepository,
  ) {}

  async evaluate(input: GeofenceCheckInput): Promise<GeofenceRecord> {
    const settings = effectiveBusinessSettings(
      await this.settings.findByBusinessId(input.businessId),
      input.enabledModules,
    );

    const verdict = geofenceVerdict({
      mode: settings.arrival_geofence_mode,
      radius_m: settings.arrival_geofence_radius_m,
      position: pointOf(input.position),
      accuracy_m: input.accuracy,
      position_age_ms: input.positionAgeMs,
      address: pointOf(input.address),
      address_precision: addressPrecisionOf(input.address),
    });

    const decision = geofenceDecision({
      mode: settings.arrival_geofence_mode,
      outcome: verdict.outcome,
      action: input.action,
      recent: isRecentSubmission(input.occurredAt, input.now ?? new Date()),
    });

    if (decision === "REFUSE") {
      throw new GeofenceRefusedError(
        input.action,
        verdict.distance_m ?? 0,
        settings.arrival_geofence_radius_m,
      );
    }

    return {
      distance_m: verdict.distance_m,
      accuracy_m: input.accuracy,
      geofence_outcome: verdict.outcome,
    };
  }
}

/**
 * The body fields every driver action at the address takes (E4). Lenient
 * like occurred_at: an unreadable value is dropped, never a 400 that the
 * app's outbox would mark as a permanent failure.
 */
const geofenceBodyFields = {
  accuracy: z
    .number()
    .nonnegative()
    .max(100_000)
    .optional()
    .catch(undefined)
    .describe(
      "Precisão da posição em metros, como o aparelho informou (opcional). Sem ela a geocerca não é avaliada e nunca bloqueia. Ilegível: ignorada.",
    ),
  position_recorded_at: z
    .string()
    .max(64)
    .optional()
    .catch(undefined)
    .describe(
      "Quando o GPS obteve a posição enviada (ISO 8601), pelo relógio do aparelho. Comparado com o occurred_at do mesmo aparelho: uma posição de mais de 2 minutos antes do toque não é avaliada pela geocerca. Opcional; ilegível: ignorado.",
    ),
};

export {
  GeofenceCheck,
  GeofenceRefusedError,
  addressPrecisionOf,
  geofenceBodyFields,
  geofencePositionAgeMs,
  readAccuracy,
};
export type { GeofenceAddress, GeofenceCheckInput, GeofenceRecord };
