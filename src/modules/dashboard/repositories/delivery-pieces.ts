import type { PeriodGranularity } from "../dtos/dashboard-dto";
import { periodBuckets } from "./period-buckets";

import {
  businessDateKey,
  businessDayStart,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * One piece of a window the "Entregas" series is counted by when it reads
 * the closed days (plano-escala F4-22, decision D52): a civil day of the
 * company, or the part of one the window clips.
 */
interface DeliveryPiece {
  /** The window's bucket the piece adds to: "YYYY-MM-DD" or "YYYY-MM". */
  period: string;
  /** [from, to), UTC instants. */
  from: Date;
  to: Date;
  /**
   * The civil day ("YYYY-MM-DD") whose stored count may answer the piece:
   * set only for a WHOLE day that had already ended at `now`. Null for a
   * clipped day, today and anything after it, which are always counted live:
   * the job stores a day only once it is over (tenant-day-rules.ts).
   */
  day: string | null;
}

/**
 * [from, to) cut into the company's civil days, each labelled with the
 * window's bucket it belongs to.
 *
 * The same boundaries the live count files a row by (period-buckets.ts) and
 * the rollup job counts a day by (dayBounds in tenant-day-rules.ts): the
 * zone's own midnights. A piece is a whole day only when both its ends are
 * that day's midnights, so a window that starts or ends mid-day (the
 * overview's "same point last month") reads its clipped day live.
 */
function deliveryPieces({
  from,
  to,
  granularity,
  timeZone,
  now,
}: {
  from: Date;
  to: Date;
  granularity: PeriodGranularity;
  timeZone: string;
  now: Date;
}): DeliveryPiece[] {
  const today = businessDateKey(now, timeZone);
  const pieces: DeliveryPiece[] = [];

  for (const bucket of periodBuckets(from, to, granularity, timeZone)) {
    const days =
      granularity === "day"
        ? [bucket]
        : periodBuckets(bucket.start, bucket.end, "day", timeZone);

    for (const civil of days) {
      const whole =
        civil.start.getTime() ===
          businessDayStart(civil.period, timeZone).getTime() &&
        civil.end.getTime() ===
          businessDayStart(shiftDateKey(civil.period, 1), timeZone).getTime();

      pieces.push({
        period: bucket.period,
        from: civil.start,
        to: civil.end,
        day: whole && civil.period < today ? civil.period : null,
      });
    }
  }

  return pieces;
}

export { deliveryPieces, type DeliveryPiece };
