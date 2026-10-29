import type { PeriodGranularity } from "../dtos/dashboard-dto";
import {
  businessDateKey,
  businessDayRange,
  businessMonthKey,
  businessMonthRange,
} from "@/shared/time/business-day";

/** One civil day or month of the company, clipped to the window asked for. */
interface PeriodBucket {
  /** "YYYY-MM-DD" or "YYYY-MM", in the company's zone. */
  period: string;
  start: Date;
  end: Date;
}

// Thirty-one days or a couple of years of months is the most any screen asks.
const MAX_BUCKETS = 1_000;

/**
 * [from, to) cut at the company's day or month boundaries.
 *
 * The dashboard used to label every row in SQL — two AT TIME ZONE, a
 * date_trunc and a to_char per row — and group by the label. On a tenant with
 * 300k deliveries that was ~300 ms per page view, a quarter of the database
 * CPU of the load test (docs/desempenho/carga-2026-10.md). The boundaries are
 * computed here instead and the table is read once, each row filed by
 * width_bucket over these boundaries (dashboard-repository countArm). The
 * labels are the same: a row belongs to the bucket whose [start, end) holds it, and
 * start/end are the zone's own midnights.
 */
function periodBuckets(
  from: Date,
  to: Date,
  granularity: PeriodGranularity,
  timeZone: string,
): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  let start = from;

  while (start < to) {
    if (buckets.length >= MAX_BUCKETS) {
      throw new RangeError(
        `Too many ${granularity} buckets between ${from.toISOString()} and ${to.toISOString()}`,
      );
    }

    const next =
      granularity === "day"
        ? businessDayRange(start, timeZone).end
        : businessMonthRange(start, timeZone).end;

    const end = next < to ? next : to;

    buckets.push({
      period:
        granularity === "day"
          ? businessDateKey(start, timeZone)
          : businessMonthKey(start, timeZone),
      start,
      end,
    });

    start = end;
  }

  return buckets;
}

export { periodBuckets, type PeriodBucket };
