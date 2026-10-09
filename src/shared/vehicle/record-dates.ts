import {
  businessDateKey,
  businessDayStart,
  dateOnlyFromKey,
  dateOnlyKey,
  resolveTimeZone,
} from "@/shared/time/business-day";

/**
 * Dates on fleet records, as a person reads them in an export.
 *
 * Acquisition, last maintenance and checklist dates are timestamps that mean
 * a DAY. The web's date picker sends the user's local midnight (03:00 UTC in
 * São Paulo), the app the moment of the inspection, a service order its
 * completion, and an API client a bare "YYYY-MM-DD", which becomes 00:00 UTC.
 * No Brazilian midnight falls on 00:00 UTC (the zones are UTC-2 to UTC-5), so
 * a value exactly there is a date-only one and its day is the UTC day; any
 * other value is an instant, read in the company's zone. Same rule as the
 * dashboard's maintenanceDayKey (modules/dashboard/repositories/maintenance-standing).
 *
 * The shared export formatters print in the server's zone (UTC in the
 * container): a checklist made at 22:00 in São Paulo came out dated the next
 * day, and "Criado em" three hours ahead.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function pickedDayKey(value: Date, timeZone: string): string {
  return value.getTime() % DAY_MS === 0
    ? dateOnlyKey(value)
    : businessDateKey(value, timeZone);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/** "17/09/2026" for a timestamp that means a day; "N/A" when empty. */
function formatPickedDay(
  value: Date | string | null | undefined,
  timeZone: string,
): string {
  const date = toDate(value);

  if (!date) return "N/A";

  const [year, month, day] = pickedDayKey(date, timeZone).split("-");

  return `${day}/${month}/${year}`;
}

/** "17/09/2026 22:10" in the company's zone; "N/A" when empty. */
function formatInstant(
  value: Date | string | null | undefined,
  timeZone: string,
): string {
  const date = toDate(value);

  if (!date) return "N/A";

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date a fleet form or API client sends: a day ("YYYY-MM-DD") that exists
 * in the calendar, or a full ISO instant. `new Date("2026-02-30")` rolls
 * over, so a day is checked against the calendar.
 */
function isPickedDateInput(value: string): boolean {
  if (DATE_ONLY.test(value)) {
    try {
      dateOnlyFromKey(value);
      return true;
    } catch {
      return false;
    }
  }

  return !Number.isNaN(new Date(value).getTime());
}

/**
 * The instant stored for a fleet record's date (fueling, checklist, service
 * order). A bare day used to reach Prisma as a string (500: DateTime wants a
 * full ISO value) or, through `new Date`, as 00:00 UTC — the evening before
 * in Brazil, which placed a checklist before the same day's readings and
 * refused a valid km. A day now starts in the company's zone, the instant the
 * web's picker sends; an instant (the app) is kept as it is.
 */
function pickedDateFromInput<T extends Date | string | null | undefined>(
  value: T,
  timeZone: string | null | undefined,
): T | Date {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return value;

  return businessDayStart(value, resolveTimeZone(timeZone));
}

export {
  formatInstant,
  formatPickedDay,
  isPickedDateInput,
  pickedDateFromInput,
  pickedDayKey,
};
