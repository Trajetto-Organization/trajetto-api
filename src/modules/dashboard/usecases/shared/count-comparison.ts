import type { DashboardEntity } from "../../dtos/dashboard-dto";

import {
  businessDateKey,
  businessDayRange,
  businessDayStart,
  businessMonthStart,
  shiftMonthKey,
} from "@/shared/time/business-day";

/**
 * What an overview card measures, and what it is compared with.
 *
 * The cards used to show what was CREATED this month: a company with twenty
 * active drivers registered last year read "Motoristas 0, -100% em relação ao
 * mês passado". Two kinds of entity, two honest measures:
 *
 * - a catalogue (vehicles, drivers, users…) is a stock: the card shows the
 *   current total, compared with the total when the company's month began;
 * - an operation (service orders, fines, deliveries, routes) is a flow: the
 *   card shows this month so far, compared with the previous month up to the
 *   same point, so the 3rd is not measured against a whole month.
 *
 * Months and days are the company's (Business.timezone), never the server's.
 */

type CountBasis = "total" | "month_to_date";

const STOCK_ENTITIES: ReadonlySet<DashboardEntity> = new Set<DashboardEntity>([
  "vehicle",
  "driver",
  "business",
  "branch",
  "part",
  "supplier",
  "user",
]);

function basisOf(entity: DashboardEntity): CountBasis {
  return STOCK_ENTITIES.has(entity) ? "total" : "month_to_date";
}

/** The UTC instant the company's current civil month began. */
function currentMonthStart(now: Date, timeZone: string): Date {
  return businessMonthStart(businessDateKey(now, timeZone).slice(0, 7), timeZone);
}

/**
 * The previous month from its first instant up to the point that matches
 * `now`: the same day of the month and the same time of day, in the
 * company's zone. A day the previous month does not have (the 31st after a
 * 30-day month) takes the whole previous month.
 */
function samePointLastMonth(now: Date, timeZone: string): { from: Date; to: Date } {
  const today = businessDateKey(now, timeZone);
  const monthKey = today.slice(0, 7);
  const monthStart = businessMonthStart(monthKey, timeZone);
  const previousKey = shiftMonthKey(monthKey, -1);
  const from = businessMonthStart(previousKey, timeZone);

  const day = Number(today.slice(8, 10));
  const [year, month] = previousKey.split("-").map(Number);
  const daysInPrevious = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (day > daysInPrevious) return { from, to: monthStart };

  const intoDay = now.getTime() - businessDayRange(now, timeZone).start.getTime();
  const sameDay = businessDayStart(`${previousKey}-${String(day).padStart(2, "0")}`, timeZone);

  return {
    from,
    to: new Date(Math.min(sameDay.getTime() + intoDay, monthStart.getTime())),
  };
}

export { STOCK_ENTITIES, basisOf, currentMonthStart, samePointLastMonth };
export type { CountBasis };
