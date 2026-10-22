/**
 * Manufacturing and model years (FLEET-VEH-3).
 *
 * Both are stored as a DateTime on 1 January, and only the year means
 * anything. The year is read in UTC: the form sends `YYYY-01-01`, which JS
 * parses as UTC midnight, and reading it in a Brazilian zone would give the
 * previous year (2026-01-01T00:00Z is 31/12/2025 21:00 in São Paulo).
 *
 * The ceiling is the current year in UTC as well. UTC is never behind a
 * Brazilian zone, so this can only be lenient for the few hours of New Year's
 * Eve when UTC has already turned; it never refuses a legitimate year.
 */

function vehicleYearOf(value: string | Date): number {
  return new Date(value).getUTCFullYear();
}

/** A vehicle is made this year at the latest. */
function maxManufacturingYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

/** The model may be next year's (a 2026/2027 truck). */
function maxModelYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** Model year equal to the manufacturing year or one after it. */
function isModelYearCoherent(
  manufacturingYear: number,
  modelYear: number,
): boolean {
  return modelYear >= manufacturingYear && modelYear <= manufacturingYear + 1;
}

/** Stored form of a year: 1 January, UTC midnight. */
function yearToDate(year: number): Date {
  return new Date(Date.UTC(year, 0, 1));
}

/**
 * The date fields of a vehicle write as Date objects.
 *
 * The schema accepts any valid date string, and Prisma's DateTime refuses a
 * bare `2024-05-01` ("premature end of input"): an API client sending the
 * date-only form got a 500. A Date built from it is UTC midnight of that day.
 */
const VEHICLE_DATE_FIELDS = [
  "acquisition_date",
  "last_maintenance_date",
  "manufacturing_year",
  "model_year",
] as const;

function withVehicleDates<
  T extends Partial<Record<(typeof VEHICLE_DATE_FIELDS)[number], unknown>>,
>(data: T): T {
  const copy = { ...data } as Record<string, unknown>;

  for (const field of VEHICLE_DATE_FIELDS) {
    const value = copy[field];

    if (typeof value === "string") copy[field] = new Date(value);
  }

  return copy as T;
}

export {
  withVehicleDates,
  isModelYearCoherent,
  maxManufacturingYear,
  maxModelYear,
  vehicleYearOf,
  yearToDate,
};
