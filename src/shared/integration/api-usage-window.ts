import { businessDayWindow, dateOnlyFromKey } from "@/shared/time/business-day";

/**
 * The days "Uso da API" covers, in the company's own calendar.
 *
 * The usage table is bucketed by business day (a DATE column holding the
 * civil day, decision 1.3). "Hoje" is the company's today: it used to be the
 * UTC day, so from 21:00 to midnight in São Paulo "Hoje" had already reset to
 * zero, and from midnight to 03:00 it still showed the previous evening
 * (DLVB-33).
 */
interface ApiUsageWindow {
  /** First day of the window, as the date-only value stored in `day`. */
  since: Date;

  /** Every day of the window, oldest first, as "YYYY-MM-DD". */
  dayKeys: string[];
}

function apiUsageWindow(
  now: Date,
  timeZone: string,
  days: number,
): ApiUsageWindow {
  // Whole days, today included: 7 days on a Monday afternoon starts on the
  // previous Tuesday, not halfway through it. The shared window keeps this
  // in step with every other daily chart.
  const { keys } = businessDayWindow(now, timeZone, days);

  // `day` is a DATE column, so the filter compares date-only values (UTC
  // midnight of the civil day), not the instant the zone's day starts.
  return { since: dateOnlyFromKey(keys[0]), dayKeys: keys };
}

export { apiUsageWindow };
export type { ApiUsageWindow };
