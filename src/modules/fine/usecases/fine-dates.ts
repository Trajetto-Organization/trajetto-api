import { AppError } from "@/shared/errors/AppError";
import {
  businessDateKey,
  businessDayStart,
  resolveTimeZone,
} from "@/shared/time/business-day";

/**
 * The calendar rules of a fine, on the company's business day (decision 1.2).
 *
 * The three dates are days to the person filling the form, so every rule
 * compares the civil day in the company's zone. The schemas used to compare
 * with the server's end of day (`setHours(23, 59, 59, 999)` on a UTC
 * container): from 21:00 in São Paulo tomorrow already passed as "today".
 * And the edit checked only the fields it received against each other, so
 * moving the infraction after the recorded payment, or into the future,
 * went through.
 *
 * The columns are instants. The form sends the day ("YYYY-MM-DD") and it is
 * stored as the instant that day starts in the company's zone, the same
 * model as the bills (account-payable-status.ts): the browser's local
 * midnight, sent before, named the day before for a company in another zone
 * (São Paulo midnight is 23:00 in Manaus). Reads add the day keys, so the
 * screens show the day the rules, the status and the export use.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant stored for a date the form sends: a day starts in the
 * company's zone; a full ISO instant (older clients) is kept as it is.
 */
function fineDateFromInput(value: Date | string, timeZone: string): Date {
  if (value instanceof Date) return value;

  return DATE_ONLY.test(value)
    ? businessDayStart(value, resolveTimeZone(timeZone))
    : new Date(value);
}

/** The three dates of a fine as days ("YYYY-MM-DD") in the company's zone. */
interface FineDays {
  violation_day: string;
  due_day: string;
  payment_day: string | null;
}

function fineDays(
  fine: {
    violation_date: Date | string;
    due_date: Date | string;
    payment_date?: Date | string | null;
  },
  timeZone: string,
): FineDays {
  const zone = resolveTimeZone(timeZone);

  return {
    violation_day: businessDateKey(new Date(fine.violation_date), zone),
    due_day: businessDateKey(new Date(fine.due_date), zone),
    payment_day: fine.payment_date
      ? businessDateKey(new Date(fine.payment_date), zone)
      : null,
  };
}

interface FineDates {
  violation_date: Date | string;
  due_date: Date | string;
  payment_date?: Date | string | null;
}

interface FineDateIssue {
  code:
    | "FINE_VIOLATION_DATE_IN_FUTURE"
    | "FINE_DUE_DATE_NOT_AFTER_VIOLATION"
    | "FINE_PAYMENT_DATE_BEFORE_VIOLATION"
    | "FINE_PAYMENT_DATE_IN_FUTURE";
  message: string;
}

function dayOf(value: Date | string, timeZone: string): string {
  return businessDateKey(new Date(value), timeZone);
}

/** The first rule the dates break, or null. Checked on the fine as it will be saved. */
function fineDateIssue(
  dates: FineDates,
  timeZone: string,
  now: Date = new Date(),
): FineDateIssue | null {
  const today = dayOf(now, timeZone);
  const violation = dayOf(dates.violation_date, timeZone);
  const due = dayOf(dates.due_date, timeZone);

  if (violation > today) {
    return {
      code: "FINE_VIOLATION_DATE_IN_FUTURE",
      message: "A data da infração não pode ser futura.",
    };
  }

  if (due <= violation) {
    return {
      code: "FINE_DUE_DATE_NOT_AFTER_VIOLATION",
      message: "A data de vencimento deve ser posterior à data da infração.",
    };
  }

  if (dates.payment_date) {
    const payment = dayOf(dates.payment_date, timeZone);

    if (payment < violation) {
      return {
        code: "FINE_PAYMENT_DATE_BEFORE_VIOLATION",
        message: "A data de pagamento não pode ser anterior à data da infração.",
      };
    }

    // A payment date records a payment that happened; one ahead of today is
    // a typo that would count the fine as paid before it is.
    if (payment > today) {
      return {
        code: "FINE_PAYMENT_DATE_IN_FUTURE",
        message: "A data de pagamento não pode ser futura.",
      };
    }
  }

  return null;
}

function assertFineDates(
  dates: FineDates,
  timeZone: string,
  now: Date = new Date(),
): void {
  const issue = fineDateIssue(dates, timeZone, now);

  if (issue) throw new AppError(issue.message, 400, issue.code);
}

export { assertFineDates, fineDateFromInput, fineDateIssue, fineDays };
export type { FineDateIssue, FineDates, FineDays };
