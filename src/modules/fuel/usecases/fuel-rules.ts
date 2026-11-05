import type { FuelAlert } from "@prisma/client";

import { AppError } from "@/shared/errors/AppError";
import type { OdometerNeighbours } from "@/shared/vehicle/odometer-timeline";
import { pickedDayKey } from "@/shared/vehicle/record-dates";
import {
  businessDateKey,
  businessDayRange,
  resolveTimeZone,
  wallClock,
} from "@/shared/time/business-day";

/**
 * A refueling dated after the company's today (decision 1.2).
 *
 * The schemas used to compare with the server's end of day
 * (`setHours(23, 59, 59, 999)` on a UTC container): from 21:00 in São Paulo
 * the next day already passed as "today", and a fueling dated tomorrow was
 * accepted. The civil day is the company's, read from Business.timezone.
 * The web sends the picked day as local midnight and the app the moment of
 * the fueling; both land on the day they mean. A bare "YYYY-MM-DD" (00:00
 * UTC, the evening before in Brazil) is the day it names: pickedDayKey, the
 * checklist's rule, so a date-only tomorrow is not read as tonight.
 */
function isRefuelingInTheFuture(
  refuelingDate: Date | string,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  const date = new Date(refuelingDate);

  if (Number.isNaN(date.getTime())) return false;

  return pickedDayKey(date, timeZone) > businessDateKey(now, timeZone);
}

/**
 * The company's zone from a business row. The Business DTO does not name the
 * column yet, but the repository returns the whole row; an absent or unknown
 * zone falls back to the default (resolveTimeZone).
 */
function businessTimeZone(business: unknown): string {
  const timezone =
    business && typeof business === "object" && "timezone" in business
      ? (business as { timezone?: unknown }).timezone
      : undefined;

  return resolveTimeZone(typeof timezone === "string" ? timezone : undefined);
}

function assertRefuelingNotInTheFuture(
  refuelingDate: Date | string | undefined,
  business: unknown,
  now: Date = new Date(),
): void {
  if (refuelingDate === undefined) return;

  if (isRefuelingInTheFuture(refuelingDate, businessTimeZone(business), now)) {
    throw new AppError(
      "A data do abastecimento não pode ser no futuro.",
      400,
      "REFUELING_DATE_IN_FUTURE",
    );
  }
}

/**
 * What an edit changes about the record's links.
 *
 * A historical record keeps its vehicle, driver and branch even after they
 * are deactivated; "only active vehicles can be fueled" is about a NEW
 * fueling. So their current state is checked only when the edit points the
 * record somewhere else (FLEET-FUEL-1): fixing the price of last month's
 * fueling of a truck sold this week is a correction, not a new fueling.
 */
function changedLinks(
  current: {
    vehicleId: string;
    driverId: string;
    branchId: string;
    fuelTypeId: string;
  },
  next: {
    vehicleId?: string;
    driverId?: string;
    branchId?: string;
    fuelTypeId?: string;
  },
): { vehicle: boolean; driver: boolean; branch: boolean; fuelType: boolean } {
  const differs = (value: string | undefined, original: string) =>
    value !== undefined && value !== original;

  return {
    vehicle: differs(next.vehicleId, current.vehicleId),
    driver: differs(next.driverId, current.driverId),
    branch: differs(next.branchId, current.branchId),
    fuelType: differs(next.fuelTypeId, current.fuelTypeId),
  };
}

/**
 * The last instant of the company's civil day the record falls on.
 *
 * The web's date picker sends the chosen day as local midnight while the app
 * sends the moment itself, so two readings of the same day can sit in the
 * wrong order by hours: "after" a web refueling of today is every checklist
 * the app sent this morning. Only readings of a LATER day are reliably after.
 */
function endOfBusinessDay(at: Date, timeZone: string): Date {
  return new Date(businessDayRange(at, timeZone).end.getTime() - 1);
}

/**
 * The odometer once the reading that set it is gone or lowered: the highest
 * reading left, never below the last maintenance. Null with nothing to go by.
 */
function releasedOdometer(
  readings: Array<number | null>,
  maintenanceFloor: number | null,
): number | null {
  const known = [...readings, maintenanceFloor].filter(
    (value): value is number => value !== null,
  );

  return known.length > 0 ? Math.max(...known) : null;
}

interface ReadingOnTimeline {
  /** The km the record carries after the write. */
  mileage: number;

  /** The readings around its (new) date, the record itself left out. */
  neighbours: OdometerNeighbours;

  /**
   * The lowest reading dated on a later civil day of the company, the record
   * left out. Null when none (always null when nothing is after it).
   */
  laterDay: number | null;

  /** The vehicle's highest reading at any date, the record left out. */
  highest: number | null;

  /** The vehicle's odometer as stored now. */
  odometer: number;

  /** The km of the vehicle's last maintenance: a released odometer never goes below it. */
  maintenanceFloor: number | null;

  /**
   * The record's km before an edit that keeps it on this vehicle; null for a
   * new record, or one an edit moves here (it never was a reading here).
   */
  previousMileage: number | null;

  /** The record's (new) date: what an equal neighbour is measured from. */
  at: Date;

  /** The company's zone (Business.timezone): which dates are only a day. */
  timeZone: string;
}

/** Refused, or accepted with the odometer the vehicle ends with (null: untouched). */
type ReadingPlacement =
  { fits: false } | { fits: true; odometer: number | null };

/**
 * The odometer never goes backwards, but it may stand still for a short
 * while (owner, 05/11/2026): a second tank, a topped-up one or a pump that
 * stopped early, all at the same stop; the depot refuelling right after the
 * departure checklist, or the arrival checklist right after it. Each reads
 * the same km as the record next to it, and the strict rule made the driver
 * type 1 km more. The app holds its own copy (trajetto-mobile,
 * features/vehicles/same-reading-rules.ts), pinned to this one by
 * tests/unitaires/contract/app-reading-windows.test.ts when the sibling
 * checkout is there. Never longer than RECENT_REFUEL_WINDOW_MINUTES: a
 * refuelling accepted at another refuelling's km is then inside that window
 * too, so it is still asked about and flagged.
 */
const SAME_READING_WINDOW_MINUTES = 30;

const SAME_READING_WINDOW_MS = SAME_READING_WINDOW_MINUTES * 60 * 1000;

/**
 * Whether a record may read the same km as a neighbouring one: their dates
 * less than SAME_READING_WINDOW_MINUTES apart, either side (a record the
 * offline queue delivers late sits BEFORE one already stored), and neither
 * of them only a day (isDayOnlyDate). The web sends the day, so two records
 * the office typed for the same day sit at its midnight, zero minutes apart
 * though nobody read the odometer then: those keep the strict rule. Without
 * the neighbour's record (not read), never.
 */
function standsStillWith(
  record: { at: Date; timeZone: string },
  neighbour: { at: Date } | null | undefined,
): boolean {
  if (!neighbour) return false;

  const at = record.at.getTime();
  const other = neighbour.at.getTime();

  if (Number.isNaN(at) || Number.isNaN(other)) return false;

  if (
    isDayOnlyDate(record.at, record.timeZone) ||
    isDayOnlyDate(neighbour.at, record.timeZone)
  ) {
    return false;
  }

  return Math.abs(at - other) < SAME_READING_WINDOW_MS;
}

/**
 * Where a reading may go on its vehicle's odometer timeline: a refueling's
 * create, edit and move (FLEET-FUEL-1), and the checklist edit, which
 * shares the timeline. The date decides first, not the odometer.
 *
 * The create and the edit used to try "ahead of the odometer" before
 * anything else: a refueling dated last week with 510.000 typed for 51.000
 * jumped above the later ones and dragged the odometer along, and after that
 * every refueling and checklist of the truck was refused.
 *
 * - Strictly between the readings before and after its date: accepted, and
 *   the vehicle is left alone (later records set the odometer).
 * - Anything else with a reading on a later civil day: refused.
 * - The newest reading, or newest but for readings of its OWN civil day:
 *   the web sends a day, not a moment (local midnight), so the app's
 *   checklist of this morning sits "after" a refueling typed for today. Above
 *   the odometer it moves it forward, as it always did; below it, only an
 *   edit of a record already on this vehicle, above the readings before it.
 *
 * When the edited record is what set the odometer, the odometer follows it
 * to the highest reading left (this one at its new km included), never below
 * the last maintenance, also when later readings exist: following it only
 * down to its own km left a 510.000 corrected between two later readings as
 * the odometer. An odometer set by something else (a MASTER's correction, a
 * service order) stays.
 *
 * With no reading before it, a new record is refused (the floor is the km
 * the vehicle was registered with, which no record carries), while the
 * vehicle's oldest record is still correctable: its km was accepted once,
 * and only the office edits.
 *
 * Standing still (05/11/2026), asked only of what the rule above refuses:
 * where it wants "above the reading before" or "below the reading after",
 * the km may also EQUAL that reading when its record stands still with this
 * one (standsStillWith: less than SAME_READING_WINDOW_MINUTES apart, neither
 * date only a day). As the newest, that is the reading just before it, and
 * a new record (or one moved here) may not sit below the odometer either: an
 * odometer a service order or a MASTER raised since that reading keeps the
 * strict rule, or the history would show it going back. So nothing the
 * strict rule accepts changes, a record with no reading before it is still
 * refused and a later day still bounds it. An equal reading is not ahead of
 * anything: it never moves the odometer forward, and a new one never lowers
 * it either (settle leaves it). Only the record that set the
 * odometer, corrected to an equal reading, takes it along as above: its old
 * km is gone, and the highest reading left holds the equal one.
 */
function placeReading({
  mileage,
  neighbours,
  laterDay,
  highest,
  odometer,
  maintenanceFloor,
  previousMileage,
  at,
  timeZone,
}: ReadingOnTimeline): ReadingPlacement {
  const { before, after } = neighbours;
  const sameVehicle = previousMileage !== null;
  const aboveBefore = before === null ? sameVehicle : mileage > before;
  const setTheOdometer = sameVehicle && odometer === previousMileage;

  const settle = (): ReadingPlacement => {
    if (!setTheOdometer) return { fits: true, odometer: null };

    const next = releasedOdometer([mileage, highest], maintenanceFloor);

    return {
      fits: true,
      odometer: next === null || next === odometer ? null : next,
    };
  };

  if (after !== null && aboveBefore && mileage < after) return settle();

  // The newest, or newest but for readings of its own civil day.
  if (after === null || laterDay === null) {
    if (mileage > odometer && (before === null || mileage > before)) {
      return { fits: true, odometer: mileage };
    }

    if (sameVehicle && aboveBefore) return settle();
  }

  // Refused so far: standing still at a neighbour's km is the one way left.
  const record = { at, timeZone };
  const stillSinceBefore =
    before !== null &&
    mileage === before &&
    standsStillWith(record, neighbours.beforeReading);
  const stillUntilAfter =
    after !== null &&
    mileage === after &&
    standsStillWith(record, neighbours.afterReading);

  const fromBefore = aboveBefore || stillSinceBefore;
  // As the newest, a new record (or one moved here) stands still at the
  // odometer at most, never below it: a service order or a MASTER may have
  // raised it since the reading before, and the history would then show it
  // going back. An edit on its own vehicle may sit below it, as any
  // correction does.
  const untilAfter =
    after === null
      ? stillSinceBefore && (sameVehicle || mileage >= odometer)
      : mileage < after || stillUntilAfter;

  if (!fromBefore || !untilAfter) return { fits: false };

  // Never forward: only readings above an odometer someone lowered by hand
  // (a MASTER) could take the released one up, and an equal reading is not
  // what may do that.
  const placed = settle();

  return placed.fits && placed.odometer !== null && placed.odometer > odometer
    ? { fits: true, odometer: null }
    : placed;
}

/**
 * A second refuelling of the same vehicle this close to another is asked
 * about, never forbidden (owner, 05/11/2026: no cooldown — several
 * refuellings a day are legitimate on a long haul, as Samsara and Geotab
 * assume). The app shows the vehicle's last refuelling and asks the driver
 * to confirm and say why; the record carries RECENT_REFUEL for the office.
 * The app holds its own copy (trajetto-mobile, features/fuel/fuel-rules.ts),
 * pinned to this one by tests/unitaires/contract/app-reading-windows.test.ts.
 */
const RECENT_REFUEL_WINDOW_MINUTES = 30;

const RECENT_REFUEL_WINDOW_MS = RECENT_REFUEL_WINDOW_MINUTES * 60 * 1000;

/**
 * Most refuellings the window read loads. A vehicle refuelled more often
 * than this within one hour is not a case worth a bigger read; the nearest
 * of the ones loaded is still flagged.
 */
const RECENT_REFUEL_CANDIDATE_LIMIT = 20;

/**
 * The first app contract (`contract` in x-trajetto-client-version,
 * CLIENT_CONTRACT in trajetto-mobile/utils/client-version.ts) whose build
 * asks the driver before a second refuelling, and so the first the server
 * refuses an unconfirmed one from. The same release as the arrival
 * checklist's rule (route-link.ts).
 */
const RECENT_REFUEL_RULE_CONTRACT = 5;

/** The reason the driver types when confirming (`recent_reason`). */
const RECENT_REASON_MIN_LENGTH = 3;
const RECENT_REASON_MAX_LENGTH = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A refuelling of the vehicle around the record's date, as the reads load it. */
interface RefuelNearby {
  id: string;
  refueling_date: Date | string;
  liters_amount: number | string | { toString(): string };
  current_mileage: number;
}

/**
 * Whether a refueling_date is a DAY rather than a moment: the web's date
 * picker sends the start of the chosen day in the company's zone, and an API
 * client's bare "YYYY-MM-DD" is 00:00 UTC (pickedDayKey reads it the same
 * way). Two refuellings the office typed for the same day both sit at its
 * midnight, zero minutes apart though nobody refuelled then, so a day is
 * never measured against the window, on either side. An app refuelling is
 * the moment of the tap (to the millisecond): landing exactly on midnight
 * is not a case worth a rule.
 */
function isDayOnlyDate(at: Date, timeZone: string): boolean {
  return (
    at.getTime() % DAY_MS === 0 ||
    businessDayRange(at, timeZone).start.getTime() === at.getTime()
  );
}

/** The dates a refuelling at `at` is measured against, both ends open. */
function recentRefuelWindow(at: Date): { after: Date; before: Date } {
  return {
    after: new Date(at.getTime() - RECENT_REFUEL_WINDOW_MS),
    before: new Date(at.getTime() + RECENT_REFUEL_WINDOW_MS),
  };
}

/**
 * The other refuelling of the vehicle less than RECENT_REFUEL_WINDOW_MINUTES
 * away from this one, or null. Either side of it: a refuelling the app
 * queued offline lands after later ones, and is judged by its own date,
 * never by when it arrived. The record itself (an edit) is left out, and so
 * is any date that is only a day (isDayOnlyDate). The nearest wins; a tie
 * goes to the earlier date, then the id, so two reads agree.
 *
 * The candidates are the vehicle's, of the record's company: the reads
 * (fuel-repository refuelsNear) scope them.
 */
function findRecentRefuel<Refuel extends RefuelNearby>(
  candidates: ReadonlyArray<Refuel>,
  record: { id?: string | null; at: Date | string; timeZone: string },
): Refuel | null {
  const at = new Date(record.at);

  if (Number.isNaN(at.getTime()) || isDayOnlyDate(at, record.timeZone)) {
    return null;
  }

  let nearest: { refuel: Refuel; distance: number; time: number } | null = null;

  for (const refuel of candidates) {
    if (record.id && refuel.id === record.id) continue;

    const time = new Date(refuel.refueling_date).getTime();

    if (Number.isNaN(time)) continue;
    if (isDayOnlyDate(new Date(time), record.timeZone)) continue;

    const distance = Math.abs(time - at.getTime());

    if (distance >= RECENT_REFUEL_WINDOW_MS) continue;

    const closer =
      nearest === null ||
      distance < nearest.distance ||
      (distance === nearest.distance &&
        (time < nearest.time ||
          (time === nearest.time && refuel.id < nearest.refuel.id)));

    if (closer) nearest = { refuel, distance, time };
  }

  return nearest?.refuel ?? null;
}

/**
 * The driver's reason when the second refuelling was confirmed, trimmed, or
 * null: confirmed is `confirm_recent` true AND a reason of at least
 * RECENT_REASON_MIN_LENGTH characters. A reason without the confirmation,
 * or a tick without a reason, is not one.
 */
function confirmedRecentReason(request: {
  confirm_recent?: boolean | null;
  recent_reason?: string | null;
}): string | null {
  if (request.confirm_recent !== true) return null;

  const reason = request.recent_reason?.trim() ?? "";

  return reason.length >= RECENT_REASON_MIN_LENGTH
    ? reason.slice(0, RECENT_REASON_MAX_LENGTH)
    : null;
}

/**
 * Whether this request is one a second refuelling within the window is
 * refused for (409 FUEL_RECENT_REFUEL) instead of recorded and flagged:
 * only when the one who could still answer can be asked.
 *
 * - a driver (a BUSINESS_USER with a driver, as resolveRecordOrigin and the
 *   arrival rule read it): the office types refuellings after the fact;
 * - from a build that asks before sending (contract RECENT_REFUEL_RULE_CONTRACT
 *   on): an older one — mobile `main` sends no header — never offered the
 *   question, and its outbox would fail what it could not avoid;
 * - sent now, not by the app's offline queue (X-Client-Queued-At): the tap
 *   happened earlier and nobody can be asked any more;
 * - not confirmed (confirmedRecentReason).
 *
 * Refused when this holds AND findRecentRefuel finds the other one; the
 * caller reads the window only then. Everything else is recorded, and the
 * alert decides itself on the record (recentRefuelAlert).
 */
function asksAboutRecentRefuel(request: {
  callerIsDriver: boolean;
  clientContract: number | null | undefined;
  queued: boolean;
  confirmed: boolean;
}): boolean {
  return (
    request.callerIsDriver &&
    typeof request.clientContract === "number" &&
    request.clientContract >= RECENT_REFUEL_RULE_CONTRACT &&
    !request.queued &&
    !request.confirmed
  );
}

/** The alert columns of a refuelling, as a create or an edit writes them. */
interface RecentRefuelColumns {
  alerts: FuelAlert[];
  recent_refuel_previous_at: Date | null;
}

/**
 * What a new refuelling stores, from the nearest other refuelling inside
 * the window (findRecentRefuel): RECENT_REFUEL with that one's date and, when
 * the driver confirmed, their reason. Decided for every refuelling,
 * whoever sends it — driver, office, offline queue, an older build — inside
 * the create's serializable transaction, so two refuellings sent at once
 * still see each other. Without a recent one, nothing: a reason sent anyway
 * is not kept.
 */
function recentRefuelAlert(
  recent: RefuelNearby | null,
  confirmedReason: string | null,
): RecentRefuelColumns & { recent_refuel_reason: string | null } {
  if (!recent) {
    return {
      alerts: [],
      recent_refuel_previous_at: null,
      recent_refuel_reason: null,
    };
  }

  return {
    alerts: ["RECENT_REFUEL"],
    recent_refuel_previous_at: new Date(recent.refueling_date),
    recent_refuel_reason: confirmedReason,
  };
}

/**
 * An office edit that moves the date or the vehicle measures the window
 * again: RECENT_REFUEL is added or taken off, any other alert kept, and the
 * other refuelling's date follows. The driver's reason is left as it is —
 * it is what they said when they sent it.
 */
function recheckedRecentRefuel(
  current: ReadonlyArray<FuelAlert>,
  recent: RefuelNearby | null,
): RecentRefuelColumns {
  const others = current.filter((alert) => alert !== "RECENT_REFUEL");

  return recent
    ? {
        alerts: [...others, "RECENT_REFUEL"],
        recent_refuel_previous_at: new Date(recent.refueling_date),
      }
    : { alerts: others, recent_refuel_previous_at: null };
}

/** "14:05", the wall clock of the company's zone (h23). */
function clockTime(at: Date | string, timeZone: string): string {
  const { hour, minute } = wallClock(new Date(at), resolveTimeZone(timeZone));

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The refusal's sentence, with the other refuelling's time in the company's
 * zone. The app shows it as it comes.
 */
function recentRefuelMessage(previousAt: Date | string, timeZone: string) {
  return `Este veículo já tem um abastecimento registrado às ${clockTime(previousAt, timeZone)}. Para registrar outro em menos de ${RECENT_REFUEL_WINDOW_MINUTES} minutos, confirme e informe o motivo.`;
}

export {
  RECENT_REASON_MAX_LENGTH,
  RECENT_REASON_MIN_LENGTH,
  RECENT_REFUEL_CANDIDATE_LIMIT,
  RECENT_REFUEL_RULE_CONTRACT,
  RECENT_REFUEL_WINDOW_MINUTES,
  RECENT_REFUEL_WINDOW_MS,
  SAME_READING_WINDOW_MINUTES,
  asksAboutRecentRefuel,
  assertRefuelingNotInTheFuture,
  businessTimeZone,
  changedLinks,
  clockTime,
  confirmedRecentReason,
  endOfBusinessDay,
  findRecentRefuel,
  isDayOnlyDate,
  isRefuelingInTheFuture,
  placeReading,
  recentRefuelAlert,
  recentRefuelMessage,
  recentRefuelWindow,
  recheckedRecentRefuel,
  releasedOdometer,
  standsStillWith,
};
export type {
  ReadingOnTimeline,
  ReadingPlacement,
  RecentRefuelColumns,
  RefuelNearby,
};
