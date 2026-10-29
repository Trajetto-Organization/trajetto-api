import {
  businessMonthKey,
  businessMonthStart,
  dateOnlyFromKey,
  resolveTimeZone,
  shiftMonthKey,
} from "@/shared/time/business-day";

/**
 * The AI quota's month, in the company's own zone (decision 1.1, AI-15).
 *
 * The period used to be the UTC month: a carrier in São Paulo had its quota
 * reset at 21:00 on the last day, and the analyses of those three hours were
 * charged to the next month, while the card said "dia 1º". The month is now
 * the company's civil month; `resetAt` is the instant its next month begins
 * there, which is what the card shows.
 */
interface QuotaPeriod {
  /** The date-only key of AIUsagePeriod.periodStart: UTC midnight of day 1. */
  periodStart: Date;

  /** When the period began, as an instant (00:00 of day 1 in the zone). */
  startsAt: Date;

  /** When the next period begins, as an instant. */
  resetAt: Date;

  timeZone: string;
}

function quotaPeriodFor(
  instant: Date,
  timeZone: string | null | undefined,
): QuotaPeriod {
  const zone = resolveTimeZone(timeZone);
  const month = businessMonthKey(instant, zone);

  return {
    periodStart: dateOnlyFromKey(`${month}-01`),
    startsAt: businessMonthStart(month, zone),
    resetAt: businessMonthStart(shiftMonthKey(month, 1), zone),
    timeZone: zone,
  };
}

export { quotaPeriodFor };
export type { QuotaPeriod };
