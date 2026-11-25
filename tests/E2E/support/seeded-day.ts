import { dayBounds } from "@/shared/rollup/tenant-day-rules";
import { businessDateKey, shiftDateKey } from "@/shared/time/business-day";

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

/**
 * Where to look for the deliveries a rollup E2E seeded `back` days before
 * `now`: half a day either side of that day's midnight in `zone`.
 *
 * The seeds sit a minute either side of the midnights of four zones and of
 * UTC (00:00 to 05:01 UTC). A window centred on `now` minus `back` days
 * instead held them only while the clock read before 17:01 UTC: a run in
 * the evening found nothing, and the test failed on `undefined.id`
 * (tenant-day-rollup, staging run of 25/11/2026 at 18:27 UTC). Centred on
 * the seeded midnight, the window holds them whatever the hour.
 */
function seededDayWindow(
  now: Date,
  zone: string,
  back: number,
): { gte: Date; lt: Date } {
  const midnight = dayBounds(
    shiftDateKey(businessDateKey(now, zone), -back),
    zone,
  ).from.getTime();

  return {
    gte: new Date(midnight - HALF_DAY_MS),
    lt: new Date(midnight + HALF_DAY_MS),
  };
}

export { seededDayWindow };
