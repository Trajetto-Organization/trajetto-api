import { businessNotFound } from "@/shared/delivery/caller-not-found";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import { logger } from "@/shared/logging/logger";
import { countLegacyContractUse } from "@/shared/http/legacy-contract-usage";

import type { IDriverPauseRepository } from "../repositories/IDriver-pause-repository";
import type { DriverPauseKind, PauseTypeInfo } from "../dtos/driver-pause-dto";

import {
  PauseRequiresRouteError,
  PauseTypeNotFoundError,
  PauseTypeWrongCategoryError,
} from "./errors/driver-pause-errors";

const log = logger.child({ component: "driver-pause" });

/** A PAUSE type with its nature: what a new pause is written with. */
type ResolvedPauseType = PauseTypeInfo & { pause_kind: DriverPauseKind };

/**
 * The type a new pause is recorded under (decision 14.4).
 *
 * With `occurrenceTypeId` (contract 3): this company's PAUSE type, active or
 * not — the pause happened, and the legal record wins over the catalogue.
 * Without it (the installed app sends `kind` alone): the seeded default of
 * that nature. The nature written is always the type's; a different `kind`
 * in the body is logged and ignored.
 */
async function resolvePauseType(
  pauses: IDriverPauseRepository,
  businessId: string,
  occurrenceTypeId: string | undefined,
  kind: DriverPauseKind | undefined,
): Promise<ResolvedPauseType> {
  if (!occurrenceTypeId) {
    // The schema requires one of the two.
    countLegacyContractUse("legacy_pause_kind");

    const fallback = await pauses.defaultPauseType(businessId, kind ?? "OTHER");

    return { ...fallback, pause_kind: fallback.pause_kind ?? kind ?? "OTHER" };
  }

  const type = await pauses.findPauseType(businessId, occurrenceTypeId);

  if (!type) throw new PauseTypeNotFoundError();

  if (type.category !== "PAUSE" || type.pause_kind === null) {
    throw new PauseTypeWrongCategoryError();
  }

  if (kind && kind !== type.pause_kind) {
    log.warn(
      { businessId, occurrenceTypeId, sentKind: kind, typeKind: type.pause_kind },
      "Pause kind differs from its type's nature; the type's is recorded",
    );
  }

  return { ...type, pause_kind: type.pause_kind };
}

/**
 * The journey route at the tap, or PAUSE_REQUIRES_ROUTE (decision 14.4).
 * The day is the company's (Business.timezone), never the server's.
 */
async function journeyRouteOrRefuse(
  pauses: IDriverPauseRepository,
  businessId: string,
  driverId: string,
  at: Date,
): Promise<string> {
  const routeId = await journeyRouteOf(pauses, businessId, driverId, at);

  if (!routeId) throw new PauseRequiresRouteError();

  return routeId;
}

/** The journey route at `at` in the company's day, or null. */
async function journeyRouteOf(
  pauses: IDriverPauseRepository,
  businessId: string,
  driverId: string,
  at: Date,
): Promise<string | null> {
  return (await journeyAt(pauses, businessId, driverId, at)).routeId;
}

/**
 * The journey at `at`, with the company's day and zone it was judged in: the
 * app trusts a cached answer only while that business day lasts (review r1:
 * a 7-day cache said "pause allowed" on a day without a route).
 */
async function journeyAt(
  pauses: IDriverPauseRepository,
  businessId: string,
  driverId: string,
  at: Date,
): Promise<{ routeId: string | null; dayKey: string; timeZone: string }> {
  const zone = await pauses.timeZoneOf(businessId);

  if (zone === null) throw businessNotFound();

  const timeZone = resolveTimeZone(zone);
  const dayKey = businessDateKey(at, timeZone);

  return {
    routeId: await pauses.findJourneyRouteAt(businessId, driverId, at, dayKey),
    dayKey,
    timeZone,
  };
}

export { journeyAt, journeyRouteOf, journeyRouteOrRefuse, resolvePauseType };
export type { ResolvedPauseType };
