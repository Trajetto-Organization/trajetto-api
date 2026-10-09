import {
  businessDateKey,
  businessDayStart,
  dateOnlyFromKey,
  shiftDateKey,
} from "@/shared/time/business-day";

import type {
  DriverPauseKind,
  PauseReportPause,
  PauseReportRoute,
  PauseReportSource,
} from "../dtos/driver-pause-dto";

/**
 * The pause report (decision 6.1): one row per driver and workday, with the
 * alerts of Lei 13.103/2015. Flags only; nothing here blocks anyone.
 *
 * What the numbers are, honestly:
 *
 * - WORKDAY. The driver's activity that belongs to one business day in the
 *   company's zone: the routes that left that day (from `started_at` to
 *   completion or cancellation; a running route counts until now) and the
 *   pauses that go with them. A pause taken inside a route belongs to that
 *   route's workday, so a night route that crosses midnight is one workday,
 *   not two. A pause outside every route goes with the nearer route, the one
 *   that ended before it or the one that starts after it, when that gap is
 *   shorter than the interjornada: a rest right after a night route belongs
 *   to that night, not to the next calendar day. Farther than that, it is a
 *   workday of its own day. The workday runs from the first route start or
 *   pause start to the last route end or pause end. Time the driver works
 *   outside a route (loading at the depot before leaving) is invisible to
 *   the system and not counted. A route forgotten in progress keeps counting
 *   until it is completed, and absorbs the pauses taken meanwhile.
 *
 * - DRIVING. Approximated as the time routes were in progress minus the
 *   pauses. It includes the minutes stopped at each customer, so it
 *   overstates the time at the wheel: the driving alert errs towards warning.
 *
 * - REST. Only pauses the driver recorded count as rest, of any kind (the
 *   meal may coincide with the driving stop, CLT art. 235-C § 2º). A gap
 *   between two routes is not assumed to be rest.
 *
 * - FORGOTTEN PAUSES. A pause open for more than 12 h, or closed only after
 *   more than 12 h, was left open by mistake: its real length is unknown.
 *   It takes no time from anything (rest, driving, the workday's end) and
 *   gets its own alert, so a pause closed the next morning can neither hide
 *   the day's missing meal nor eat the night's interjornada.
 *
 * The rules (CLT arts. 71 and 235-C; CTB art. 67-C, as Lei 13.103/2015 wrote
 * them and the STF left them in the ADI 5322):
 *
 * - MEAL: a workday over 6 h needs a meal break of at least 1 h. Compared
 *   against the longest continuous meal interval (overlapping MEAL records
 *   merged), since the interval is one period.
 * - DRIVING REST: 30 min of rest within each 6 h of driving, which may be
 *   split. Driving accumulates until the rests taken since the last reset add
 *   up to 30 min; more than 6 h accumulated is the alert. The 5h30 limit of
 *   uninterrupted driving is not checked: route time is not wheel time.
 * - INTERJORNADA: 11 h between the end of the previous workday and the start
 *   of this one, continuous (the ADI 5322 struck down splitting it).
 */
const PAUSE_LAW = {
  mealMinMinutes: 60,
  mealRequiredAboveWorkdayMinutes: 360,
  drivingBlockMinutes: 360,
  drivingRestMinutes: 30,
  interjornadaMinutes: 660,

  /**
   * A pause open for longer than this, or closed only after it, was
   * forgotten: its length is not a pause's length.
   */
  forgottenPauseMinutes: 720,
} as const;

/** The longest range the report answers, in days (inclusive). */
const PAUSE_REPORT_MAX_DAYS = 31;

/**
 * The years a report day may fall in. `Date.UTC` reads years 0-99 as
 * 1900-1999 and the date helpers throw past year 9999, so a key outside a
 * sane window is refused as a range, never turned into a 500 or a silent
 * other century.
 */
const PAUSE_REPORT_YEARS = { first: 2000, last: 2099 } as const;

/** Days read before the range, to find the workday before its first day. */
const LOOKBACK_DAYS = 2;

const PAUSE_FLAG_CODES = [
  "MEAL_MISSING",
  "MEAL_SHORT",
  "DRIVING_REST_SHORT",
  "INTERJORNADA_SHORT",
  "PAUSE_NOT_ENDED",
  "PAUSE_TOO_LONG",
] as const;

type PauseFlagCode = (typeof PAUSE_FLAG_CODES)[number];

interface PauseFlag {
  code: PauseFlagCode;
  message: string;
}

/**
 * ENDED and ONGOING count. NOT_ENDED (open for more than 12 h) and TOO_LONG
 * (closed only after more than 12 h) were forgotten and count for nothing.
 */
type ReportPauseStatus = "ENDED" | "ONGOING" | "NOT_ENDED" | "TOO_LONG";

interface ReportPauseEntry {
  id: string;
  kind: DriverPauseKind;
  /** The PAUSE type the driver chose (decision 14.4); null in older sources. */
  occurrence_type_name: string | null;
  status: ReportPauseStatus;
  started_at: string;
  ended_at: string | null;

  /**
   * Ended: its length. Ongoing: so far. Too long: the recorded length, shown
   * but not counted. Not ended: null (unknown).
   */
  duration_minutes: number | null;

  note: string | null;
  routeId: string | null;
}

interface DriverDayTotals {
  /** Union of the pauses (overlaps counted once), per kind too. */
  pauseMinutes: number;
  mealMinutes: number;
  longestMealMinutes: number;
  restMinutes: number;
  otherMinutes: number;

  /** Route time minus pauses (see the module docblock). */
  drivingMinutes: number;
  longestDrivingWithoutRestMinutes: number;
}

interface DriverDayReport {
  /** `<driverId>:<day>`, stable across pages (the table's row identity). */
  id: string;
  day: string;
  driverId: string;
  driverName: string;

  /** A route still running or a pause going on: the day is not over yet. */
  inProgress: boolean;

  workday: { start: string; end: string; minutes: number };
  pauses: ReportPauseEntry[];
  totals: DriverDayTotals;

  /** End of the driver's previous workday, when one is within reach. */
  previousWorkdayEnd: string | null;
  restBeforeMinutes: number | null;

  flags: PauseFlag[];
}

interface ReportRange {
  from: string;
  to: string;

  /** Where the report's rows live: [start of `from`, start of `to` + 1). */
  start: Date;
  end: Date;

  /** What is read: the lookback before, and one day after for late pauses. */
  loadStart: Date;
  loadEnd: Date;
}

class ReportRangeInvalid extends Error {}

/**
 * The days a report covers, in the company's zone. Without `to`, the
 * company's today; without `from`, the six days before `to` (a week).
 */
function resolveReportRange(
  { from, to }: { from?: string; to?: string },
  timeZone: string,
  now: Date,
): ReportRange {
  const invalidDay = () =>
    new ReportRangeInvalid(
      `Data inválida. Use o formato AAAA-MM-DD, entre ${PAUSE_REPORT_YEARS.first} e ${PAUSE_REPORT_YEARS.last}.`,
    );

  const inWindow = (key: string) => {
    let year: number;

    try {
      year = dateOnlyFromKey(key).getUTCFullYear();
    } catch {
      return false;
    }

    return year >= PAUSE_REPORT_YEARS.first && year <= PAUSE_REPORT_YEARS.last;
  };

  // Checked before any shift: the helpers throw a bare RangeError on a key
  // they cannot move, and `to` is shifted below.
  if ((to !== undefined && !inWindow(to)) || (from !== undefined && !inWindow(from))) {
    throw invalidDay();
  }

  const lastDay = to ?? businessDateKey(now, timeZone);
  const firstDay = from ?? shiftDateKey(lastDay, -6);

  if (!inWindow(firstDay) || !inWindow(lastDay)) throw invalidDay();

  if (firstDay > lastDay) {
    throw new ReportRangeInvalid("A data inicial deve ser anterior ou igual à final.");
  }

  const days =
    (dateOnlyFromKey(lastDay).getTime() - dateOnlyFromKey(firstDay).getTime()) /
      86_400_000 +
    1;

  if (days > PAUSE_REPORT_MAX_DAYS) {
    throw new ReportRangeInvalid(
      `O período pode ter no máximo ${PAUSE_REPORT_MAX_DAYS} dias.`,
    );
  }

  try {
    return {
      from: firstDay,
      to: lastDay,
      start: businessDayStart(firstDay, timeZone),
      end: businessDayStart(shiftDateKey(lastDay, 1), timeZone),
      loadStart: businessDayStart(shiftDateKey(firstDay, -LOOKBACK_DAYS), timeZone),
      loadEnd: businessDayStart(shiftDateKey(lastDay, 2), timeZone),
    };
  } catch (error) {
    // Unreachable inside the year window; a helper's RangeError must still
    // leave as the report's 400, never as a 500.
    if (error instanceof RangeError) throw invalidDay();

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Time spans, in epoch milliseconds.
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

/** Sorted, overlaps and touching spans merged, empty spans dropped. */
function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .map((span) => ({ ...span }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];

    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }

  return merged;
}

/** `base` minus `cut`, both already merged. */
function subtractSpans(base: readonly Span[], cut: readonly Span[]): Span[] {
  return base.flatMap((span) =>
    cut.reduce<Span[]>(
      (pieces, hole) =>
        pieces.flatMap((piece) => {
          if (hole.end <= piece.start || hole.start >= piece.end) return [piece];

          return [
            ...(hole.start > piece.start ? [{ start: piece.start, end: hole.start }] : []),
            ...(hole.end < piece.end ? [{ start: hole.end, end: piece.end }] : []),
          ];
        }),
      [{ ...span }],
    ),
  );
}

const lengthOf = (spans: readonly Span[]) =>
  spans.reduce((total, span) => total + (span.end - span.start), 0);

const minutesOf = (ms: number) => Math.max(0, Math.floor(ms / 60_000));

/**
 * The longest stretch of driving without the rest the law asks for, in ms.
 *
 * Driving adds to a counter; recorded rest adds to a second one, and once the
 * rest adds up to 30 min both reset (the rest may be split, CTB art. 67-C
 * § 1º). The answer is the counter's peak.
 */
function longestDrivingWithoutRest(
  driving: readonly Span[],
  rest: readonly Span[],
  restNeededMs = PAUSE_LAW.drivingRestMinutes * 60_000,
): number {
  const segments = [
    ...driving.map((span) => ({ ...span, driving: true })),
    ...rest.map((span) => ({ ...span, driving: false })),
  ].sort((a, b) => a.start - b.start || Number(b.driving) - Number(a.driving));

  let since = 0;
  let rested = 0;
  let longest = 0;

  for (const segment of segments) {
    const length = segment.end - segment.start;

    if (segment.driving) {
      since += length;
      longest = Math.max(longest, since);
      continue;
    }

    rested += length;

    if (rested >= restNeededMs) {
      since = 0;
      rested = 0;
    }
  }

  return longest;
}

// ---------------------------------------------------------------------------
// Wording.
// ---------------------------------------------------------------------------

/** "40 min", "1 h", "1 h 05 min", "12 h 30 min". */
function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;

  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;

  return `${hours} h ${String(rest).padStart(2, "0")} min`;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(instant: Date, timeZone: string) {
  let formatter = wallFormatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      hourCycle: "h23",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    wallFormatters.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";

  return {
    date: `${part("day")}/${part("month")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/** "27/09 às 22:10", in the company's zone. */
function wallLabel(instant: Date, timeZone: string): string {
  const { date, time } = wallParts(instant, timeZone);

  return `${date} às ${time}`;
}

function flagFor(
  code: PauseFlagCode,
  facts: {
    workdayMinutes?: number;
    /** A meal was recorded, but only as a forgotten pause. */
    onlyForgottenMeal?: boolean;
    longestMealMinutes?: number;
    longestDrivingMinutes?: number;
    restBeforeMinutes?: number;
    previousEnd?: Date;
    notEndedStart?: Date;
    tooLong?: { start: Date; end: Date; minutes: number };
    timeZone: string;
  },
): PauseFlag {
  switch (code) {
    case "MEAL_MISSING":
      return {
        code,
        message: `Jornada de ${formatMinutes(facts.workdayMinutes ?? 0)} ${
          facts.onlyForgottenMeal
            ? "sem pausa de refeição com duração válida: a registrada ficou aberta por mais de 12 horas e fica fora dos cálculos"
            : "sem pausa de refeição registrada"
        }. Jornadas acima de 6 horas pedem intervalo de no mínimo 1 hora para refeição (CLT, art. 71 e art. 235-C, § 2º).`,
      };
    case "MEAL_SHORT":
      return {
        code,
        message: `A maior pausa de refeição durou ${formatMinutes(facts.longestMealMinutes ?? 0)}. O intervalo para refeição é de no mínimo 1 hora (CLT, art. 71 e art. 235-C, § 2º).`,
      };
    case "DRIVING_REST_SHORT":
      return {
        code,
        message: `${formatMinutes(facts.longestDrivingMinutes ?? 0)} de direção estimada sem somar 30 min de descanso. A lei pede 30 min de descanso a cada 6 horas de direção (CTB, art. 67-C, § 1º). A direção é estimada pelo tempo de rota em andamento menos as pausas.`,
      };
    case "INTERJORNADA_SHORT":
      return {
        code,
        message: `Descanso de ${formatMinutes(facts.restBeforeMinutes ?? 0)} desde o fim da jornada anterior (${
          facts.previousEnd ? wallLabel(facts.previousEnd, facts.timeZone) : "—"
        }). O intervalo entre jornadas é de 11 horas seguidas (CLT, art. 235-C, § 3º).`,
      };
    case "PAUSE_NOT_ENDED":
      return {
        code,
        message: `A pausa iniciada em ${
          facts.notEndedStart ? wallLabel(facts.notEndedStart, facts.timeZone) : "—"
        } não foi encerrada no aplicativo; a duração dela fica fora dos cálculos.`,
      };
    case "PAUSE_TOO_LONG":
      return {
        code,
        message: facts.tooLong
          ? `A pausa iniciada em ${wallLabel(facts.tooLong.start, facts.timeZone)} só foi encerrada em ${wallLabel(
              facts.tooLong.end,
              facts.timeZone,
            )}, depois de ${formatMinutes(
              facts.tooLong.minutes,
            )}. Mais de 12 horas indica que ela ficou aberta por esquecimento no aplicativo; a duração dela fica fora dos cálculos.`
          : "Uma pausa foi encerrada depois de mais de 12 horas; a duração dela fica fora dos cálculos.",
      };
  }
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/** Names sorted the way a Brazilian reads them; one collator, not one per call. */
const NAME_ORDER = new Intl.Collator("pt-BR", { sensitivity: "base" });

const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * businessDateKey, remembered per UTC quarter hour. Every zone's offset and
 * every clock change fall on a quarter hour, so the instants of one UTC
 * quarter hour share a civil day. The report asks for a day per route and
 * per pause, and Intl formatting was most of its time.
 */
function civilDayOf(timeZone: string): (instant: Date) => string {
  const days = new Map<number, string>();

  return (instant) => {
    const bucket = Math.floor(instant.getTime() / QUARTER_HOUR_MS);
    let day = days.get(bucket);

    if (day === undefined) {
      day = businessDateKey(instant, timeZone);
      days.set(bucket, day);
    }

    return day;
  };
}

interface RouteItem extends Span {
  route: PauseReportRoute;
  day: string;
  running: boolean;
}

interface PauseItem extends Span {
  pause: PauseReportPause;
  day: string;
  status: ReportPauseStatus;
}

interface Workday {
  driverId: string;
  day: string;
  routes: RouteItem[];
  pauses: PauseItem[];
}

/**
 * One driver's routes by start, for the pause lookups. `latestEnd[i]` is the
 * index of the route that ends last among `routes[0..i]`: it answers both
 * "can any earlier route still be running?" and "which route ended last
 * before this instant?" without scanning the driver's whole list.
 */
interface DriverRoutes {
  routes: RouteItem[];
  latestEnd: number[];
}

/**
 * Every route grouped by driver, once. The report used to scan every route
 * of the company for each pause (pauses × routes on the event loop); per
 * driver and by binary search it is about P log R.
 */
function indexRoutesByDriver(routes: readonly RouteItem[]): Map<string, DriverRoutes> {
  const byDriver = new Map<string, RouteItem[]>();

  for (const route of routes) {
    const driverId = route.route.driverId;
    const list = byDriver.get(driverId);

    if (list) list.push(route);
    else byDriver.set(driverId, [route]);
  }

  const index = new Map<string, DriverRoutes>();

  for (const [driverId, list] of byDriver) {
    list.sort((a, b) => a.start - b.start || a.route.id.localeCompare(b.route.id));

    const latestEnd: number[] = [];

    list.forEach((route, position) => {
      const previous = position > 0 ? latestEnd[position - 1] : -1;

      latestEnd.push(previous >= 0 && list[previous].end >= route.end ? previous : position);
    });

    index.set(driverId, { routes: list, latestEnd });
  }

  return index;
}

/** The last position whose route started at or before `at`, or -1. */
function lastStartedBy(routes: readonly RouteItem[], at: number): number {
  let low = 0;
  let high = routes.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (routes[middle].start <= at) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

/**
 * The route whose workday a pause belongs to, or null for the pause's own
 * calendar day (see the module docblock):
 *
 * 1. the latest-started route on the street when the pause began;
 * 2. else the nearer of the route that ended last before it and the next to
 *    start after it, when that gap is under `maxGapMs` (the interjornada).
 *    A tie goes to the route before: the workday already under way.
 */
function routeForPause(
  driver: DriverRoutes | undefined,
  pauseStart: number,
  pauseEnd: number,
  maxGapMs: number,
): RouteItem | null {
  if (!driver) return null;

  const { routes, latestEnd } = driver;
  const last = lastStartedBy(routes, pauseStart);

  for (let position = last; position >= 0; position -= 1) {
    // No route up to here reaches the pause: none contains it.
    if (routes[latestEnd[position]].end < pauseStart) break;

    if (routes[position].end >= pauseStart) return routes[position];
  }

  const before = last >= 0 ? routes[latestEnd[last]] : null;
  const after = last + 1 < routes.length ? routes[last + 1] : null;

  const gapBefore = before ? pauseStart - before.end : Infinity;
  const gapAfter = after ? Math.max(0, after.start - pauseEnd) : Infinity;

  const nearer = gapBefore <= gapAfter ? before : after;
  const gap = Math.min(gapBefore, gapAfter);

  return nearer && gap < maxGapMs ? nearer : null;
}

interface BuildPauseReportInput {
  timeZone: string;
  now: Date;

  /** The days rows are produced for, inclusive ("YYYY-MM-DD"). */
  from: string;
  to: string;

  source: PauseReportSource;
}

/**
 * Every driver-day with activity in [from, to], newest day first, then by
 * driver name. Built from the source of the whole load window, so the first
 * day still finds the workday before it.
 */
function buildPauseReport({
  timeZone,
  now,
  from,
  to,
  source,
}: BuildPauseReportInput): DriverDayReport[] {
  const nowMs = now.getTime();
  const forgottenMs = PAUSE_LAW.forgottenPauseMinutes * 60_000;
  const interjornadaMs = PAUSE_LAW.interjornadaMinutes * 60_000;
  const dayOf = civilDayOf(timeZone);

  const routes: RouteItem[] = source.routes.map((route) => {
    const start = route.started_at.getTime();
    const running = route.ended_at === null;
    const end = running
      ? Math.max(start, nowMs)
      : Math.max(start, (route.ended_at as Date).getTime());

    return { start, end, running, route, day: dayOf(route.started_at) };
  });

  const routesByDriver = indexRoutesByDriver(routes);

  const pauses: PauseItem[] = source.pauses.map((pause) => {
    const start = pause.started_at.getTime();

    let status: ReportPauseStatus;
    let end: number;

    if (pause.ended_at) {
      const endedAt = Math.max(start, pause.ended_at.getTime());

      // Closed only after more than 12 h: forgotten open, then closed. Its
      // recorded length is not a pause's, so it spans nothing.
      status = endedAt - start > forgottenMs ? "TOO_LONG" : "ENDED";
      end = status === "TOO_LONG" ? start : endedAt;
    } else if (nowMs - start > forgottenMs) {
      // Forgotten: its length is unknown, so it takes no time from anything.
      status = "NOT_ENDED";
      end = start;
    } else {
      status = "ONGOING";
      end = Math.max(start, nowMs);
    }

    const route = routeForPause(routesByDriver.get(pause.driverId), start, end, interjornadaMs);

    return {
      start,
      end,
      pause,
      status,
      day: route ? route.day : dayOf(pause.started_at),
    };
  });

  const workdays = new Map<string, Workday>();

  const workdayOf = (driverId: string, day: string) => {
    const key = `${driverId}:${day}`;
    let workday = workdays.get(key);

    if (!workday) {
      workday = { driverId, day, routes: [], pauses: [] };
      workdays.set(key, workday);
    }

    return workday;
  };

  for (const route of routes) workdayOf(route.route.driverId, route.day).routes.push(route);
  for (const pause of pauses) workdayOf(pause.pause.driverId, pause.day).pauses.push(pause);

  const names = new Map(source.drivers.map((driver) => [driver.id, driver.name]));

  // Oldest first per driver, so each workday meets the one before it.
  const ordered = [...workdays.values()].sort(
    (a, b) =>
      (a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0) ||
      (a.day < b.day ? -1 : a.day > b.day ? 1 : 0),
  );

  const rows: DriverDayReport[] = [];
  let previous: { driverId: string; end: number } | null = null;

  const isTimed = (pause: PauseItem) => pause.status === "ENDED" || pause.status === "ONGOING";
  const sum = (spans: readonly Span[]) => lengthOf(mergeSpans(spans));

  for (const workday of ordered) {
    const items: Span[] = [...workday.routes, ...workday.pauses];
    let start = Infinity;
    let end = -Infinity;

    for (const item of items) {
      if (item.start < start) start = item.start;
      if (item.end > end) end = item.end;
    }

    const inProgress =
      workday.routes.some((route) => route.running) ||
      workday.pauses.some((pause) => pause.status === "ONGOING");

    const timed = workday.pauses.filter(isTimed);
    const restSpans = mergeSpans(timed);
    const routeSpans = mergeSpans(workday.routes);
    const driving = subtractSpans(routeSpans, restSpans);
    const longestDriving = longestDrivingWithoutRest(driving, restSpans);

    const spansOf = (kind: DriverPauseKind) => timed.filter((pause) => pause.pause.kind === kind);

    // Two overlapping meal pauses are one meal interval, not two.
    const meals = mergeSpans(spansOf("MEAL"));
    const longestMeal = meals.reduce((longest, span) => Math.max(longest, span.end - span.start), 0);

    const previousEnd =
      previous && previous.driverId === workday.driverId ? previous.end : null;
    const restBefore = previousEnd === null ? null : Math.max(0, start - previousEnd);

    previous = { driverId: workday.driverId, end };

    if (workday.day < from || workday.day > to) continue;

    const workdayMs = end - start;
    const flags: PauseFlag[] = [];
    const facts = { timeZone };

    // A day still going on has not missed its meal yet.
    if (!inProgress && workdayMs > PAUSE_LAW.mealRequiredAboveWorkdayMinutes * 60_000) {
      if (meals.length === 0) {
        flags.push(
          flagFor("MEAL_MISSING", {
            ...facts,
            workdayMinutes: minutesOf(workdayMs),
            onlyForgottenMeal: workday.pauses.some(
              (pause) => pause.pause.kind === "MEAL" && !isTimed(pause),
            ),
          }),
        );
      } else if (longestMeal < PAUSE_LAW.mealMinMinutes * 60_000) {
        flags.push(
          flagFor("MEAL_SHORT", { ...facts, longestMealMinutes: minutesOf(longestMeal) }),
        );
      }
    }

    if (longestDriving > PAUSE_LAW.drivingBlockMinutes * 60_000) {
      flags.push(
        flagFor("DRIVING_REST_SHORT", {
          ...facts,
          longestDrivingMinutes: minutesOf(longestDriving),
        }),
      );
    }

    if (
      restBefore !== null &&
      previousEnd !== null &&
      restBefore < PAUSE_LAW.interjornadaMinutes * 60_000
    ) {
      flags.push(
        flagFor("INTERJORNADA_SHORT", {
          ...facts,
          restBeforeMinutes: minutesOf(restBefore),
          previousEnd: new Date(previousEnd),
        }),
      );
    }

    const forgotten = workday.pauses.find((pause) => pause.status === "NOT_ENDED");

    if (forgotten) {
      flags.push(
        flagFor("PAUSE_NOT_ENDED", {
          ...facts,
          notEndedStart: forgotten.pause.started_at,
        }),
      );
    }

    const closedLate = workday.pauses.find((pause) => pause.status === "TOO_LONG");

    if (closedLate && closedLate.pause.ended_at) {
      flags.push(
        flagFor("PAUSE_TOO_LONG", {
          ...facts,
          tooLong: {
            start: closedLate.pause.started_at,
            end: closedLate.pause.ended_at,
            minutes: minutesOf(
              closedLate.pause.ended_at.getTime() - closedLate.pause.started_at.getTime(),
            ),
          },
        }),
      );
    }

    rows.push({
      id: `${workday.driverId}:${workday.day}`,
      day: workday.day,
      driverId: workday.driverId,
      driverName: names.get(workday.driverId) ?? "",
      inProgress,
      workday: {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        minutes: minutesOf(workdayMs),
      },
      pauses: [...workday.pauses]
        .sort((a, b) => a.start - b.start || a.pause.id.localeCompare(b.pause.id))
        .map((pause) => ({
          id: pause.pause.id,
          kind: pause.pause.kind,
          occurrence_type_name: pause.pause.occurrence_type_name ?? null,
          status: pause.status,
          started_at: pause.pause.started_at.toISOString(),
          ended_at: pause.pause.ended_at ? pause.pause.ended_at.toISOString() : null,
          duration_minutes:
            pause.status === "NOT_ENDED"
              ? null
              : pause.status === "TOO_LONG" && pause.pause.ended_at
                ? minutesOf(pause.pause.ended_at.getTime() - pause.start)
                : minutesOf(pause.end - pause.start),
          note: pause.pause.note,
          routeId: pause.pause.routeId,
        })),
      totals: {
        pauseMinutes: minutesOf(lengthOf(restSpans)),
        mealMinutes: minutesOf(lengthOf(meals)),
        longestMealMinutes: minutesOf(longestMeal),
        restMinutes: minutesOf(sum(spansOf("REST"))),
        otherMinutes: minutesOf(sum(spansOf("OTHER"))),
        drivingMinutes: minutesOf(lengthOf(driving)),
        longestDrivingWithoutRestMinutes: minutesOf(longestDriving),
      },
      previousWorkdayEnd: previousEnd === null ? null : new Date(previousEnd).toISOString(),
      restBeforeMinutes: restBefore === null ? null : minutesOf(restBefore),
      flags,
    });
  }

  return rows.sort(
    (a, b) =>
      b.day.localeCompare(a.day) ||
      NAME_ORDER.compare(a.driverName, b.driverName) ||
      a.driverId.localeCompare(b.driverId),
  );
}

// ---------------------------------------------------------------------------
// Filters, cards and facets (decision 8.8, disjunctive rule).
// ---------------------------------------------------------------------------

interface ReportFilters {
  driverIds?: string[];
  flags?: PauseFlagCode[];
}

interface FacetCount {
  value: string;
  label?: string;
  count: number;
}

interface PauseReportSearchMeta {
  /** Driver-days with every filter. */
  days: number;
  drivers: number;
  pauses: number;

  /** Driver-days with an alert, with the driver filter only. */
  daysWithAlerts: number;

  facets: {
    driverId: FacetCount[];
    flag: FacetCount[];
  };
}

/**
 * The rows the filters keep, and the cards and facet counts. A number broken
 * down by a facet counts every OTHER filter but not its own, so choosing a
 * driver never turns the other drivers' counts to zero.
 */
function summarizePauseReport(
  rows: readonly DriverDayReport[],
  filters: ReportFilters,
  driverNames: ReadonlyMap<string, string>,
): { rows: DriverDayReport[]; searchMeta: PauseReportSearchMeta } {
  const chosenDrivers = new Set(filters.driverIds ?? []);
  const chosenFlags = new Set<string>(filters.flags ?? []);

  const byDriver = (row: DriverDayReport) =>
    chosenDrivers.size === 0 || chosenDrivers.has(row.driverId);
  const byFlag = (row: DriverDayReport) =>
    chosenFlags.size === 0 || row.flags.some((flag) => chosenFlags.has(flag.code));

  const kept = rows.filter((row) => byDriver(row) && byFlag(row));
  const forDriverFacet = rows.filter(byFlag);
  const forFlagFacet = rows.filter(byDriver);

  const driverCounts = new Map<string, number>();

  for (const row of forDriverFacet) {
    driverCounts.set(row.driverId, (driverCounts.get(row.driverId) ?? 0) + 1);
  }

  // A chosen driver with nothing left keeps its chip, with a zero — but only
  // one of this company (the name comes from its own records).
  for (const id of filters.driverIds ?? []) {
    if (!driverCounts.has(id) && driverNames.has(id)) driverCounts.set(id, 0);
  }

  const driverFacet = [...driverCounts.entries()]
    .map(([value, count]) => ({ value, label: driverNames.get(value) ?? "", count }))
    .sort(
      (a, b) =>
        NAME_ORDER.compare(a.label, b.label) || a.value.localeCompare(b.value),
    );

  const flagFacet = PAUSE_FLAG_CODES.map((code) => ({
    value: code,
    count: forFlagFacet.filter((row) => row.flags.some((flag) => flag.code === code))
      .length,
  }));

  return {
    rows: kept,
    searchMeta: {
      days: kept.length,
      drivers: new Set(kept.map((row) => row.driverId)).size,
      pauses: kept.reduce((total, row) => total + row.pauses.length, 0),
      daysWithAlerts: forFlagFacet.filter((row) => row.flags.length > 0).length,
      facets: { driverId: driverFacet, flag: flagFacet },
    },
  };
}

export {
  LOOKBACK_DAYS,
  PAUSE_FLAG_CODES,
  PAUSE_LAW,
  PAUSE_REPORT_MAX_DAYS,
  PAUSE_REPORT_YEARS,
  ReportRangeInvalid,
  buildPauseReport,
  formatMinutes,
  longestDrivingWithoutRest,
  mergeSpans,
  resolveReportRange,
  subtractSpans,
  summarizePauseReport,
};
export type {
  DriverDayReport,
  DriverDayTotals,
  PauseFlag,
  PauseFlagCode,
  PauseReportSearchMeta,
  ReportFilters,
  ReportPauseEntry,
  ReportPauseStatus,
  ReportRange,
  Span,
};
