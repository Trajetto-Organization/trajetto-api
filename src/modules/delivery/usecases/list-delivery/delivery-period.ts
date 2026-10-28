import { z } from "zod";

import {
  businessDayStart,
  businessDayWindow,
  dateOnlyFromKey,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * The deliveries listing's period (meeting of 14/10/2026).
 *
 * The Entregas screen opens on today: a carrier with ~3,000 deliveries a day
 * reads today's work, and a first page that counted the company's whole
 * history for the cards and the pager was the heaviest read of the board. The
 * period is a range of civil days in the company's zone (decision 1.1),
 * applied to created_at as [start of the first day, start of the day after
 * the last one).
 *
 * Absent, the listing covers every date: the public API, the chat's context
 * picker and every caller written before the period keep their answer.
 */

const DELIVERY_PERIODS = ["today", "7d", "14d", "30d", "custom"] as const;

type DeliveryPeriod = (typeof DELIVERY_PERIODS)[number];

/** Each preset: the last N civil days, today included. */
const PRESET_DAYS: Record<Exclude<DeliveryPeriod, "custom">, number> = {
  today: 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

/**
 * The longest custom range: a quarter (three consecutive months reach 92
 * days). Wider than that, the counts read a large slice of the company again,
 * and the export (which takes the same filters) is the tool for a year.
 */
const MAX_CUSTOM_PERIOD_DAYS = 92;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

interface DeliveryPeriodInput {
  period?: DeliveryPeriod;
  /** "YYYY-MM-DD", only with `custom`. */
  from?: string;
  to?: string;
}

/** A period resolved in the company's zone. */
interface DeliveryPeriodWindow {
  /** First civil day, "YYYY-MM-DD", included. */
  from: string;
  /** Last civil day, "YYYY-MM-DD", included. */
  to: string;
  /** created_at >= start AND created_at < end. */
  start: Date;
  end: Date;
}

function isDateKey(value: string | undefined): value is string {
  if (!value || !DATE_KEY.test(value)) return false;

  try {
    dateOnlyFromKey(value);
    return true;
  } catch {
    return false;
  }
}

/** A civil day on the querystring, kept as its "YYYY-MM-DD" key. */
function periodDateField(label: string) {
  return z
    .string({
      invalid_type_error: `${label} deve estar no formato AAAA-MM-DD.`,
    })
    .superRefine((value, ctx) => {
      if (!DATE_KEY.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} deve estar no formato AAAA-MM-DD.`,
        });

        return;
      }

      if (!isDateKey(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} não é uma data válida.`,
        });
      }
    })
    .optional();
}

/** Days from `from` to `to`, both included. */
function periodLength(from: string, to: string): number {
  return (
    Math.round(
      (dateOnlyFromKey(to).getTime() - dateOnlyFromKey(from).getTime()) /
        DAY_MS,
    ) + 1
  );
}

/**
 * The rules that need more than one field: `from`/`to` belong to `custom`
 * (and only there), in order, at most MAX_CUSTOM_PERIOD_DAYS apart.
 */
function refineDeliveryPeriod(
  value: DeliveryPeriodInput,
  ctx: z.RefinementCtx,
): void {
  const { period, from, to } = value;

  if (period !== "custom") {
    // A date next to a preset (or with no period) would be silently ignored,
    // and the screen would show a range the person did not ask for.
    if (from !== undefined || to !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [from !== undefined ? "from" : "to"],
        message: "As datas do período (from e to) só valem com period=custom.",
      });
    }

    return;
  }

  if (from === undefined || to === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [from === undefined ? "from" : "to"],
      message:
        "No período personalizado, informe a data inicial (from) e a final (to), no formato AAAA-MM-DD.",
    });

    return;
  }

  // The field rules already reported a malformed day.
  if (!isDateKey(from) || !isDateKey(to)) return;

  if (from > to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["from"],
      message: "A data inicial do período não pode ser depois da data final.",
    });

    return;
  }

  if (periodLength(from, to) > MAX_CUSTOM_PERIOD_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: `O período personalizado pode ter no máximo ${MAX_CUSTOM_PERIOD_DAYS} dias. Para um intervalo maior, exporte por partes.`,
    });
  }
}

/**
 * The [start, end) a validated period covers in `timeZone`, or null for "every
 * date". `now` is the caller's clock; nothing here reads the server's zone.
 */
function deliveryPeriodWindow(
  input: DeliveryPeriodInput,
  timeZone: string,
  now: Date = new Date(),
): DeliveryPeriodWindow | null {
  if (!input.period) return null;

  if (input.period === "custom") {
    // The schema refuses custom without both days; reaching here without
    // them is a caller that skipped it, and "every date" is the safe reading.
    if (!isDateKey(input.from) || !isDateKey(input.to)) return null;

    return {
      from: input.from,
      to: input.to,
      start: businessDayStart(input.from, timeZone),
      end: businessDayStart(shiftDateKey(input.to, 1), timeZone),
    };
  }

  const window = businessDayWindow(now, timeZone, PRESET_DAYS[input.period]);

  return {
    from: window.keys[0],
    to: window.keys[window.keys.length - 1],
    start: window.start,
    end: window.end,
  };
}

export {
  DELIVERY_PERIODS,
  MAX_CUSTOM_PERIOD_DAYS,
  deliveryPeriodWindow,
  periodDateField,
  refineDeliveryPeriod,
  type DeliveryPeriod,
  type DeliveryPeriodInput,
  type DeliveryPeriodWindow,
};
