/**
 * The business day of a company, in the company's own time zone.
 *
 * Containers run in UTC and must keep doing so: date-only columns are stored
 * as UTC midnight of the civil day, and a process-wide TZ would shift them.
 * So every "today", "last N days", quota period and daily bucket is computed
 * here, explicitly, from `Business.timezone` — never with setHours(0,0,0,0)
 * or toISOString().slice(0, 10), which silently mean "the server's day".
 */

const DEFAULT_BUSINESS_TIMEZONE = "America/Sao_Paulo";

// Brazilian zones from the IANA database (zone1970.tab, BR). A company picks
// one; anything else is refused so a typo cannot move every counter.
const BRAZILIAN_TIME_ZONES = [
  "America/Noronha",
  "America/Belem",
  "America/Fortaleza",
  "America/Recife",
  "America/Araguaina",
  "America/Maceio",
  "America/Bahia",
  "America/Sao_Paulo",
  "America/Campo_Grande",
  "America/Cuiaba",
  "America/Santarem",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Manaus",
  "America/Eirunepe",
  "America/Rio_Branco",
] as const;

type BrazilianTimeZone = (typeof BRAZILIAN_TIME_ZONES)[number];

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type BusinessDayRange = { start: Date; end: Date };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    // h23 keeps midnight as 00; some engines print 24 with hour12:false.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function isBrazilianTimeZone(timeZone: string): timeZone is BrazilianTimeZone {
  return (BRAZILIAN_TIME_ZONES as readonly string[]).includes(timeZone);
}

/** Falls back to the default when a row carries an empty or unknown zone. */
function resolveTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_BUSINESS_TIMEZONE;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Local wall time minus UTC, in ms, at that instant (negative west of UTC).
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;

  return wallAsUtc - wholeSeconds;
}

function showsWallTime(utc: number, timeZone: string, wallAsUtc: number): boolean {
  const wall = wallClock(new Date(utc), timeZone);

  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) === wallAsUtc;
}

/**
 * The UTC instant of a wall-clock time in a zone. Day and month overflow are
 * normalized by Date.UTC (day 32 = next month).
 *
 * Brazil has had no DST since 2019, but the tz data keeps the history, and a
 * DST night makes a wall time ambiguous (fall back: earliest instant wins) or
 * nonexistent (spring forward at midnight: the day starts at the first
 * instant that exists, 01:00).
 */
function zonedWallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // The offsets in force a day either side: a DST change in between gives two
  // candidates. Guessing from wallAsUtc alone read only the offset after the
  // change east of UTC, so a repeated hour there resolved to the later
  // instant (Europe/Berlin 2026-10-25 02:30 → 01:30Z instead of 00:30Z).
  const offsets = new Set([
    zoneOffsetMs(new Date(wallAsUtc - DAY_MS), timeZone),
    zoneOffsetMs(new Date(wallAsUtc), timeZone),
    zoneOffsetMs(new Date(wallAsUtc + DAY_MS), timeZone),
  ]);

  const candidates = [...offsets].map((offset) => wallAsUtc - offset);

  if (candidates.length === 1) return new Date(candidates[0]);

  const matching = candidates.filter((utc) => showsWallTime(utc, timeZone, wallAsUtc));

  return new Date(matching.length > 0 ? Math.min(...matching) : Math.max(...candidates));
}

/** "YYYY-MM-DD" of the civil day the instant falls on, in that zone. */
function businessDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = wallClock(instant, timeZone);

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** [start, end) of the civil day containing the instant, as UTC instants. */
function businessDayRange(instant: Date, timeZone: string): BusinessDayRange {
  const { year, month, day } = wallClock(instant, timeZone);

  return {
    start: zonedWallTimeToUtc(timeZone, year, month, day),
    end: zonedWallTimeToUtc(timeZone, year, month, day + 1),
  };
}

/** [start, end) of the last `days` civil days, today included. */
function businessDaysRange(instant: Date, timeZone: string, days: number): BusinessDayRange {
  const { year, month, day } = wallClock(instant, timeZone);

  return {
    start: zonedWallTimeToUtc(timeZone, year, month, day - (days - 1)),
    end: zonedWallTimeToUtc(timeZone, year, month, day + 1),
  };
}

/** [start, end) of the civil month containing the instant. */
function businessMonthRange(instant: Date, timeZone: string): BusinessDayRange {
  const { year, month } = wallClock(instant, timeZone);

  return {
    start: zonedWallTimeToUtc(timeZone, year, month, 1),
    end: zonedWallTimeToUtc(timeZone, year, month + 1, 1),
  };
}

/**
 * The value to store in (or compare with) a date-only column (`@db.Date`):
 * UTC midnight of the civil day. Prisma reads such columns back the same way.
 */
function dateOnlyFromKey(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new RangeError(`Invalid date-only key: ${key}`);
  }

  const date = new Date(`${key}T00:00:00.000Z`);

  // Rejects 2026-02-30 and the like, which Date silently rolls over.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
    throw new RangeError(`Invalid date-only key: ${key}`);
  }

  return date;
}

/** Today's date-only value for a company. */
function businessToday(timeZone: string, now: Date = new Date()): Date {
  return dateOnlyFromKey(businessDateKey(now, timeZone));
}

/** The "YYYY-MM-DD" of a date-only column value (stored as UTC midnight). */
function dateOnlyKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** "YYYY-MM" of the civil month the instant falls on, in that zone. */
function businessMonthKey(instant: Date, timeZone: string): string {
  return businessDateKey(instant, timeZone).slice(0, 7);
}

/** A "YYYY-MM-DD" moved by whole calendar days; no clock is involved. */
function shiftDateKey(key: string, days: number): string {
  const moved = dateOnlyFromKey(key);

  moved.setUTCDate(moved.getUTCDate() + days);

  return dateOnlyKey(moved);
}

function parseMonthKey(key: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const month = match ? Number(match[2]) : 0;

  if (!match || month < 1 || month > 12) {
    throw new RangeError(`Invalid month key: ${key}`);
  }

  return { year: Number(match[1]), month };
}

/** A "YYYY-MM" moved by whole months (12 months = one year). */
function shiftMonthKey(key: string, months: number): string {
  const { year, month } = parseMonthKey(key);
  const index = year * 12 + (month - 1) + months;
  const monthIndex = ((index % 12) + 12) % 12;

  return `${Math.floor(index / 12)}-${String(monthIndex + 1).padStart(2, "0")}`;
}

/**
 * A "YYYY-MM-DD" moved by whole months, clamped to the end of the month
 * (31/08 + 1 month = 30/09), exactly like Postgres `date + interval 'N month'`.
 * JS `setMonth` rolls over instead (01/10) and reads the server's calendar.
 */
function shiftDateKeyByMonths(key: string, months: number): string {
  const day = dateOnlyFromKey(key).getUTCDate();
  const monthKey = shiftMonthKey(key.slice(0, 7), months);
  const { year, month } = parseMonthKey(monthKey);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return `${monthKey}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** The UTC instant the civil day `key` starts in that zone. */
function businessDayStart(key: string, timeZone: string): Date {
  const day = dateOnlyFromKey(key);

  return zonedWallTimeToUtc(
    timeZone,
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
  );
}

/** The UTC instant the civil month `key` starts in that zone. */
function businessMonthStart(key: string, timeZone: string): Date {
  const { year, month } = parseMonthKey(key);

  return zonedWallTimeToUtc(timeZone, year, month, 1);
}

/** Buckets of a chart: their keys oldest first, and the [start, end) they cover. */
interface BusinessWindow {
  keys: string[];
  start: Date;
  end: Date;
}

/** The last `days` civil days, today included, as "YYYY-MM-DD" buckets. */
function businessDayWindow(instant: Date, timeZone: string, days: number): BusinessWindow {
  const today = businessDateKey(instant, timeZone);
  const keys = Array.from({ length: days }, (_, index) =>
    shiftDateKey(today, index - (days - 1)),
  );

  return {
    keys,
    start: businessDayStart(keys[0], timeZone),
    end: businessDayStart(shiftDateKey(today, 1), timeZone),
  };
}

/** The last `months` civil months, the current one included, as "YYYY-MM" buckets. */
function businessMonthWindow(instant: Date, timeZone: string, months: number): BusinessWindow {
  const current = businessMonthKey(instant, timeZone);
  const keys = Array.from({ length: months }, (_, index) =>
    shiftMonthKey(current, index - (months - 1)),
  );

  return {
    keys,
    start: businessMonthStart(keys[0], timeZone),
    end: businessMonthStart(shiftMonthKey(current, 1), timeZone),
  };
}

export {
  BRAZILIAN_TIME_ZONES,
  DEFAULT_BUSINESS_TIMEZONE,
  businessDateKey,
  businessDayRange,
  businessDayStart,
  businessDayWindow,
  businessDaysRange,
  businessMonthKey,
  businessMonthRange,
  businessMonthStart,
  businessMonthWindow,
  businessToday,
  dateOnlyFromKey,
  dateOnlyKey,
  isBrazilianTimeZone,
  isValidTimeZone,
  resolveTimeZone,
  shiftDateKey,
  shiftDateKeyByMonths,
  shiftMonthKey,
  zonedWallTimeToUtc,
};
export type { BrazilianTimeZone, BusinessDayRange, BusinessWindow };
