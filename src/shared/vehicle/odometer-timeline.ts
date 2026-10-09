import type { Prisma } from "@prisma/client";

import { businessDayRange } from "@/shared/time/business-day";

/**
 * Where a late reading fits on a vehicle's odometer.
 *
 * The rule for a fueling or a checklist has always been "strictly more than
 * the vehicle's current mileage", and it still is — for the record that moves
 * the odometer forward, which is almost every record. What it got wrong was a
 * record that is not the newest: the app's outbox sends a fueling queued
 * without signal hours or days later, and by then a checklist, or the manager
 * on the web, has moved the odometer past it. Compared with the vehicle as it
 * is NOW, a true reading from the past can never be "more", so the fueling —
 * its cost, its litres, its photo — could not be entered at all, from the app
 * or from the web.
 *
 * So a record the forward rule refuses gets a second question: does its
 * reading fit the vehicle's history at its own date? Strictly above every
 * record before it and strictly below every record after it — the same
 * strictly-increasing rule, applied along time instead of along arrival, and
 * only where a record on EACH side bounds it. A record that fits is stored
 * without touching the vehicle's mileage: the later records already put it
 * where it is, and lowering it would undo them.
 *
 * Every write is now decided by its date first (placeReading in
 * modules/fuel/usecases/fuel-rules, over what odometerTimeline reads): the
 * fueling create and edit, and the checklist create and edit. A record with
 * readings on a later day cannot jump the odometer, and the newest one can be
 * corrected downwards. The "forward first" order that used to run on the
 * creates let a back-dated record typed too high drag the odometer along.
 */

interface OdometerNeighbours {
  /** The highest reading dated at or before the record. Null when none. */
  before: number | null;

  /** The lowest reading dated after the record. Null when none. */
  after: number | null;
}

/**
 * Whether a reading the forward rule refused belongs in the vehicle's past.
 *
 * Only ever asked after "more than the current mileage" failed. With no
 * record after it, the record IS the newest and the forward rule was right to
 * refuse it. With no record before it, it is refused too: the floor there is
 * the mileage the vehicle was registered with, which no fueling or checklist
 * carries, so any reading below the next record would pass — 9 000 km on a
 * vehicle registered at 50 000, a typo or a fake the forward rule refused.
 */
function fitsOdometerTimeline(
  mileage: number,
  { before, after }: OdometerNeighbours,
): boolean {
  if (after === null || before === null) return false;

  return mileage > before && mileage < after;
}

interface OdometerNeighboursQuery {
  businessId: string;
  vehicleId: string;
  at: Date;

  /**
   * The record being edited, left out of its own neighbours: correcting the
   * km of an old fueling or checklist compared it with its previous value,
   * so a typo could never be fixed downwards (FLEET-FUEL-1).
   */
  excludeFuelId?: string;
  excludeChecklistId?: string;
}

/**
 * The readings around a date, across fuelings and checklists: the two kinds
 * of record that carry the vehicle's odometer. Run inside the caller's
 * serializable transaction, so a record committed concurrently either is seen
 * here or makes this transaction retry.
 */
async function odometerNeighbours(
  tx: Prisma.TransactionClient,
  {
    businessId,
    vehicleId,
    at,
    excludeFuelId,
    excludeChecklistId,
  }: OdometerNeighboursQuery,
): Promise<OdometerNeighbours> {
  const notFuel = excludeFuelId ? { id: { not: excludeFuelId } } : {};
  const notChecklist = excludeChecklistId
    ? { id: { not: excludeChecklistId } }
    : {};

  const fuelBefore = await tx.fuel.aggregate({
    where: { businessId, vehicleId, refueling_date: { lte: at }, ...notFuel },
    _max: { current_mileage: true },
  });

  const fuelAfter = await tx.fuel.aggregate({
    where: { businessId, vehicleId, refueling_date: { gt: at }, ...notFuel },
    _min: { current_mileage: true },
  });

  const checklistBefore = await tx.vehicleChecklist.aggregate({
    where: {
      businessId,
      vehicleId,
      checklist_date: { lte: at },
      ...notChecklist,
    },
    _max: { current_mileage: true },
  });

  const checklistAfter = await tx.vehicleChecklist.aggregate({
    where: {
      businessId,
      vehicleId,
      checklist_date: { gt: at },
      ...notChecklist,
    },
    _min: { current_mileage: true },
  });

  const highest = (...values: Array<number | null>) => {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? Math.max(...present) : null;
  };

  const lowest = (...values: Array<number | null>) => {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? Math.min(...present) : null;
  };

  return {
    before: highest(
      fuelBefore._max.current_mileage,
      checklistBefore._max.current_mileage,
    ),
    after: lowest(
      fuelAfter._min.current_mileage,
      checklistAfter._min.current_mileage,
    ),
  };
}

/** Every reading is dated before it: the "before" there is the vehicle's highest. */
const END_OF_TIME = new Date("9999-12-31T23:59:59.999Z");

interface OdometerTimelineQuery extends OdometerNeighboursQuery {
  /** The company's zone: which readings fall on a LATER civil day. */
  timeZone: string;
}

/** What placeReading needs of a vehicle's history around one record. */
interface OdometerTimeline {
  neighbours: OdometerNeighbours;

  /**
   * The lowest reading dated on a later civil day of the company, the record
   * left out; null when none. The web's date picker places a record at local
   * midnight and the app at the moment itself, so only a LATER day is
   * reliably after it.
   */
  laterDay: number | null;

  /** The vehicle's highest reading at any date, the record left out. */
  highest: number | null;
}

/**
 * The history placeReading decides on, read inside the caller's
 * serializable transaction. The newest reading (the usual case) costs the
 * four aggregates it always did; the day and overall reads only run for a
 * record with readings after its date. Shared by the fueling and the
 * checklist edits: one timeline holds both.
 */
async function odometerTimeline(
  tx: Prisma.TransactionClient,
  { timeZone, ...query }: OdometerTimelineQuery,
): Promise<OdometerTimeline> {
  const neighbours = await odometerNeighbours(tx, query);

  if (neighbours.after === null) {
    return { neighbours, laterDay: null, highest: neighbours.before };
  }

  const endOfDay = new Date(
    businessDayRange(query.at, timeZone).end.getTime() - 1,
  );
  const restOfDay = await odometerNeighbours(tx, { ...query, at: endOfDay });

  if (restOfDay.after === null) {
    return { neighbours, laterDay: null, highest: restOfDay.before };
  }

  const overall = await odometerNeighbours(tx, { ...query, at: END_OF_TIME });

  return { neighbours, laterDay: restOfDay.after, highest: overall.before };
}

interface ReleasedReading {
  businessId: string;
  vehicleId: string;

  /** The km of the record that leaves the vehicle (deleted or moved away). */
  leaving: number;

  excludeFuelId?: string;
  excludeChecklistId?: string;
}

/**
 * A reading leaves a vehicle (deleted, or moved to another one). When it is
 * what set the odometer, the odometer goes back to the highest reading left,
 * never below the last maintenance. Left on the gone value, every later
 * fueling and checklist of the truck had to beat a km no record supports,
 * and only a MASTER edits the odometer. With nothing left to go by, it stays.
 * Conditional on the value read, like every odometer write here.
 */
async function releaseOdometer(
  tx: Prisma.TransactionClient,
  {
    businessId,
    vehicleId,
    leaving,
    excludeFuelId,
    excludeChecklistId,
  }: ReleasedReading,
): Promise<void> {
  const vehicle = await tx.vehicle.findFirst({
    where: { id: vehicleId, businessId },
    select: { current_mileage: true, last_maintenance_mileage: true },
  });

  if (!vehicle || vehicle.current_mileage !== leaving) return;

  const { before: highest } = await odometerNeighbours(tx, {
    businessId,
    vehicleId,
    at: END_OF_TIME,
    excludeFuelId,
    excludeChecklistId,
  });

  const known = [highest, vehicle.last_maintenance_mileage].filter(
    (value): value is number => value !== null,
  );

  if (known.length === 0) return;

  const next = Math.max(...known);

  if (next >= vehicle.current_mileage) return;

  await tx.vehicle.updateMany({
    where: {
      id: vehicleId,
      businessId,
      current_mileage: vehicle.current_mileage,
    },
    data: { current_mileage: next },
  });
}

/** The date a record is placed at; the column default when none was sent. */
function recordDate(value: Date | string | null | undefined): Date {
  return value ? new Date(value) : new Date();
}

export {
  END_OF_TIME,
  fitsOdometerTimeline,
  odometerNeighbours,
  odometerTimeline,
  recordDate,
  releaseOdometer,
};
export type {
  OdometerNeighbours,
  OdometerNeighboursQuery,
  OdometerTimeline,
  OdometerTimelineQuery,
  ReleasedReading,
};
