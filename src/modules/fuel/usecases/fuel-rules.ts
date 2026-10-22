import { AppError } from "@/shared/errors/AppError";
import type { OdometerNeighbours } from "@/shared/vehicle/odometer-timeline";
import { pickedDayKey } from "@/shared/vehicle/record-dates";
import {
  businessDateKey,
  businessDayRange,
  resolveTimeZone,
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
}

/** Refused, or accepted with the odometer the vehicle ends with (null: untouched). */
type ReadingPlacement =
  | { fits: false }
  | { fits: true; odometer: number | null };

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
 */
function placeReading({
  mileage,
  neighbours: { before, after },
  laterDay,
  highest,
  odometer,
  maintenanceFloor,
  previousMileage,
}: ReadingOnTimeline): ReadingPlacement {
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

  if (after !== null && laterDay !== null) return { fits: false };

  if (mileage > odometer && (before === null || mileage > before)) {
    return { fits: true, odometer: mileage };
  }

  if (!sameVehicle || !aboveBefore) return { fits: false };

  return settle();
}

export {
  assertRefuelingNotInTheFuture,
  businessTimeZone,
  changedLinks,
  endOfBusinessDay,
  isRefuelingInTheFuture,
  placeReading,
  releasedOdometer,
};
export type { ReadingOnTimeline, ReadingPlacement };
