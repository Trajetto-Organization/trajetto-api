import { z } from "zod";

import {
  businessDateKey,
  businessDayStart,
  businessDayWindow,
  dateOnlyFromKey,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * The period of a listing (meeting of 14/10/2026 for Entregas; Rotas and the
 * Torre's board by route since 09/11/2026).
 *
 * A screen that read the company's whole history on every open — to show
 * today's work — opens on today instead: presets of the last 1, 7, 14 or 30
 * civil days, or a custom range of at most MAX_CUSTOM_PERIOD_DAYS. The days
 * are the company's (decision 1.1), resolved here in its zone; the browser
 * only names them.
 *
 * What a day of the period means is each listing's own: Entregas reads it on
 * `created_at` (an instant, through `listPeriodWindow`), Rotas on the route's
 * day (`scheduled_date`, a civil date, through `listPeriodDays`).
 *
 * Absent, a listing covers every date: the public API and every caller
 * written before the period keep their answer.
 */

const LIST_PERIODS = ["today", "7d", "14d", "30d", "custom"] as const;

type ListPeriod = (typeof LIST_PERIODS)[number];

/** Each preset: the last N civil days, today included. */
const PRESET_DAYS: Record<Exclude<ListPeriod, "custom">, number> = {
  today: 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

/**
 * The longest custom range: a quarter (three consecutive months reach 92
 * days). Wider than that, the counts read a large slice of the company again.
 */
const MAX_CUSTOM_PERIOD_DAYS = 92;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

interface ListPeriodInput {
  period?: ListPeriod;
  /** "YYYY-MM-DD", only with `custom`. */
  from?: string;
  to?: string;
}

/** A period resolved in the company's zone, as instants. */
interface ListPeriodWindow {
  /** First civil day, "YYYY-MM-DD", included. */
  from: string;
  /** Last civil day, "YYYY-MM-DD", included. */
  to: string;
  /** An instant column >= start AND < end. */
  start: Date;
  end: Date;
}

/** A period resolved in the company's zone, as civil days only. */
interface ListPeriodDays {
  /** First civil day, "YYYY-MM-DD", included. */
  from: string;
  /** Last civil day, "YYYY-MM-DD", included. */
  to: string;
  /** The company's today, "YYYY-MM-DD": a custom range may not contain it. */
  today: string;
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

/**
 * The three querystring fields of a period, the same names, texts and rules
 * on every listing that takes one; `description` says what the period is
 * read on (the creation, the route's day) and what ignores it.
 */
function listPeriodFields(description: string) {
  return {
    period: z
      .enum(LIST_PERIODS, {
        errorMap: () => ({
          message: `Período inválido. Use: ${LIST_PERIODS.join(", ")}.`,
        }),
      })
      .optional()
      .describe(description),
    from: periodDateField("A data inicial do período").describe(
      "Primeiro dia do período custom (AAAA-MM-DD), incluído. Só com period=custom.",
    ),
    to: periodDateField("A data final do período").describe(
      "Último dia do período custom (AAAA-MM-DD), incluído. Só com period=custom.",
    ),
  };
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
 * `tooLongAdvice` follows the too-long sentence where the listing has a way
 * around the cap (Entregas: its export).
 */
function refineListPeriod({ tooLongAdvice }: { tooLongAdvice?: string } = {}): (
  value: ListPeriodInput,
  ctx: z.RefinementCtx,
) => void {
  return (value, ctx) => {
    const { period, from, to } = value;

    if (period !== "custom") {
      // A date next to a preset (or with no period) would be silently
      // ignored, and the screen would show a range the person did not ask
      // for.
      if (from !== undefined || to !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [from !== undefined ? "from" : "to"],
          message:
            "As datas do período (from e to) só valem com period=custom.",
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
        message: `O período personalizado pode ter no máximo ${MAX_CUSTOM_PERIOD_DAYS} dias.${tooLongAdvice ? ` ${tooLongAdvice}` : ""}`,
      });
    }
  };
}

/**
 * The civil days a validated period covers in `timeZone`, or null for "every
 * date". `now` is the caller's clock; nothing here reads the server's zone.
 */
function listPeriodDays(
  input: ListPeriodInput,
  timeZone: string,
  now: Date = new Date(),
): ListPeriodDays | null {
  if (!input.period) return null;

  const today = businessDateKey(now, timeZone);

  if (input.period === "custom") {
    // The schema refuses custom without both days; reaching here without
    // them is a caller that skipped it, and "every date" is the safe reading.
    if (!isDateKey(input.from) || !isDateKey(input.to)) return null;

    return { from: input.from, to: input.to, today };
  }

  return {
    from: shiftDateKey(today, -(PRESET_DAYS[input.period] - 1)),
    to: today,
    today,
  };
}

/**
 * The [start, end) a validated period covers in `timeZone`, or null for "every
 * date": for a listing that reads the period on an instant column.
 */
function listPeriodWindow(
  input: ListPeriodInput,
  timeZone: string,
  now: Date = new Date(),
): ListPeriodWindow | null {
  if (!input.period) return null;

  if (input.period === "custom") {
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
  LIST_PERIODS,
  MAX_CUSTOM_PERIOD_DAYS,
  listPeriodDays,
  listPeriodFields,
  listPeriodWindow,
  periodDateField,
  refineListPeriod,
  type ListPeriod,
  type ListPeriodDays,
  type ListPeriodInput,
  type ListPeriodWindow,
};
