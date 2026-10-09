import {
  dateOnlyFromKey,
  dateOnlyKey,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * Pure rules of the driver catalogue, apart from any repository so they can
 * be proven on their own.
 */

/** Route statuses that still need their driver (decision 8.3). */
const OPEN_ROUTE_STATUSES = ["PLANNED", "RELEASED", "IN_PROGRESS"] as const;

type OpenRouteStatus = (typeof OPEN_ROUTE_STATUSES)[number];

type OpenRouteCounts = Record<OpenRouteStatus, number>;

const NO_OPEN_ROUTES: OpenRouteCounts = {
  PLANNED: 0,
  RELEASED: 0,
  IN_PROGRESS: 0,
};

function totalOpenRoutes(counts: OpenRouteCounts): number {
  return counts.PLANNED + counts.RELEASED + counts.IN_PROGRESS;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The refusal, with the counts and what to do about each kind: a route in
 * progress is finished or cancelled; one that has not left is handed to
 * another driver or cancelled. Each step speaks of one route or of several,
 * as the count says.
 */
function openRoutesRefusal(counts: OpenRouteCounts): string {
  const waiting = counts.PLANNED + counts.RELEASED;

  const parts = [
    counts.IN_PROGRESS > 0 &&
      plural(counts.IN_PROGRESS, "rota em andamento", "rotas em andamento"),
    waiting > 0 &&
      plural(waiting, "rota planejada ou liberada", "rotas planejadas ou liberadas"),
  ].filter(Boolean);

  const steps = [
    counts.IN_PROGRESS > 0 &&
      (counts.IN_PROGRESS === 1
        ? "conclua ou cancele a rota em andamento"
        : "conclua ou cancele as rotas em andamento"),
    waiting > 0 &&
      (waiting === 1
        ? "designe outro motorista ou cancele a rota que ainda não saiu"
        : "designe outro motorista ou cancele as rotas que ainda não saíram"),
  ].filter(Boolean);

  return (
    `Não é possível inativar este motorista: ele tem ${parts.join(" e ")}. ` +
    `Antes de inativá-lo, ${steps.join(" e ")}.`
  );
}

/** How close to the expiry date a CNH starts to be flagged. */
const CNH_EXPIRING_WINDOW_DAYS = 30;

type CnhValidity = "EXPIRED" | "EXPIRING" | "VALID";

/**
 * Where a CNH stands on the company's business day (decision 1.2).
 *
 * The expiry is a civil date (`@db.Date`, UTC midnight), and the licence is
 * valid through that whole day; `todayKey` is the company's "YYYY-MM-DD", never
 * the server's. No date on file answers null: legacy drivers predate it.
 */
function cnhValidity(
  expiresAt: Date | string | null | undefined,
  todayKey: string,
): CnhValidity | null {
  if (!expiresAt) return null;

  const expires = new Date(expiresAt);

  if (Number.isNaN(expires.getTime())) return null;

  const expiresKey = dateOnlyKey(expires);

  if (expiresKey < todayKey) return "EXPIRED";

  if (expiresKey <= shiftDateKey(todayKey, CNH_EXPIRING_WINDOW_DAYS)) {
    return "EXPIRING";
  }

  return "VALID";
}

/**
 * A CNH is issued for at most ten years (CTB art. 147 §2, Lei 14.071/2020),
 * so an expiry beyond that from today is a typo, not a licence.
 */
const CNH_MAX_VALIDITY_YEARS = 10;

/** Nothing before this is a real expiry; it catches "0001" and the like. */
const CNH_EARLIEST_EXPIRY = "1970-01-01";

/**
 * Why a typed CNH expiry cannot be stored, or null when it can. An expired
 * date is accepted on purpose: the licence may lapse while the driver is on
 * file, and the assignment warns about it instead (decision 8.5).
 *
 * Mirrored by the web form (src/features/driver/lib/driver-rules.ts).
 */
function cnhExpiryIssue(value: string, todayKey: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "A validade da CNH deve ser uma data no formato AAAA-MM-DD.";
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  // Rejects 2026-02-30, which Date would roll over to March.
  if (Number.isNaN(date.getTime()) || dateOnlyKey(date) !== value) {
    return "A validade da CNH não é uma data válida.";
  }

  if (value < CNH_EARLIEST_EXPIRY) {
    return "A validade da CNH é anterior a 1970. Confira a data.";
  }

  const latest = `${Number(todayKey.slice(0, 4)) + CNH_MAX_VALIDITY_YEARS}${todayKey.slice(4)}`;

  if (value > latest) {
    return `A validade da CNH não pode passar de ${CNH_MAX_VALIDITY_YEARS} anos a partir de hoje.`;
  }

  return null;
}

type CnhCategoryCode = "A" | "B" | "C" | "D" | "E" | "AB" | "AC" | "AD" | "AE";

/**
 * The four-wheel classes nest (CTB art. 143): C also drives what B drives, D
 * what C drives, E what D drives. A (two or three wheels) is apart, and the
 * combined categories hold A plus one of the others.
 */
const FOUR_WHEEL_LEVEL: Record<string, number> = { B: 1, C: 2, D: 3, E: 4 };

function cnhParts(category: CnhCategoryCode): { motorcycle: boolean; level: number } {
  const motorcycle = category.startsWith("A");
  const fourWheel = motorcycle ? category.slice(1) : category;

  return { motorcycle, level: FOUR_WHEEL_LEVEL[fourWheel] ?? 0 };
}

type CnhCoverage = "COVERED" | "NOT_COVERED" | "UNKNOWN";

/**
 * Whether a driver's CNH category allows the vehicle type's required one,
 * for the assignment's warning (decision 8.5: it warns, never blocks). No
 * requirement on the type is covered; no category on file is UNKNOWN, which
 * the warning says as "categoria não informada" rather than as a mismatch.
 */
function cnhCategoryCoverage(
  held: CnhCategoryCode | null | undefined,
  required: CnhCategoryCode | null | undefined,
): CnhCoverage {
  if (!required) return "COVERED";

  if (!held) return "UNKNOWN";

  const has = cnhParts(held);
  const needs = cnhParts(required);

  const motorcycleOk = !needs.motorcycle || has.motorcycle;
  const fourWheelOk = has.level >= needs.level;

  return motorcycleOk && fourWheelOk ? "COVERED" : "NOT_COVERED";
}

/** CTB art. 140 I: a CNH is only issued from 18. */
const DRIVER_MIN_AGE = 18;

/** Nothing before this is a real birth date; it catches "0199" and the like. */
const EARLIEST_BIRTH_DATE = "1900-01-01";

/**
 * The civil day a typed birth date names, or null when it names none.
 *
 * "YYYY-MM-DD" is the day itself (the form's date-only field). An instant is
 * read on its UTC calendar: the legacy form sent local midnight of a
 * Brazilian zone (02:00 to 05:00 UTC), which is still that day in UTC — in
 * the browser's zone the stored UTC midnight would read as the day before.
 */
function birthDateKeyOf(value: string): string | null {
  const text = value.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    try {
      return dateOnlyKey(dateOnlyFromKey(text));
    } catch {
      return null;
    }
  }

  // An instant must carry its date part; "12" or "abc" are not birth dates.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;

  const instant = new Date(text);

  return Number.isNaN(instant.getTime()) ? null : dateOnlyKey(instant);
}

/**
 * Whether someone born on `birthKey` has turned `age` on `todayKey`, both
 * civil days. The anniversary is the same month and day `age` years later,
 * compared as text: born on 29/02, the birthday in a common year falls on
 * 01/03, the day after the missing one (Código Civil art. 132 §3).
 */
function hasTurned(birthKey: string, todayKey: string, age: number): boolean {
  const year = String(Number(birthKey.slice(0, 4)) + age).padStart(4, "0");

  return `${year}${birthKey.slice(4)}` <= todayKey;
}

/**
 * Why a typed birth date cannot be stored, or null when it can. `todayKey`
 * is a civil day, never the server's calendar (decision 1.2): the container
 * runs in UTC, whose tomorrow starts at 21:00 in São Paulo.
 *
 * Mirrored by the web form (src/features/driver/lib/driver-rules.ts).
 */
function birthDateIssue(value: string, todayKey: string): string | null {
  const key = birthDateKeyOf(value);

  if (!key) return "Data de nascimento inválida.";

  if (key < EARLIEST_BIRTH_DATE) {
    return "A data de nascimento é anterior a 1900. Confira a data.";
  }

  if (!hasTurned(key, todayKey, DRIVER_MIN_AGE)) {
    return `O motorista deve ter pelo menos ${DRIVER_MIN_AGE} anos.`;
  }

  return null;
}

export {
  cnhCategoryCoverage,
  type CnhCategoryCode,
  type CnhCoverage,
  birthDateIssue,
  birthDateKeyOf,
  DRIVER_MIN_AGE,
  EARLIEST_BIRTH_DATE,
  hasTurned,
  CNH_EARLIEST_EXPIRY,
  CNH_MAX_VALIDITY_YEARS,
  cnhExpiryIssue,
  CNH_EXPIRING_WINDOW_DAYS,
  NO_OPEN_ROUTES,
  OPEN_ROUTE_STATUSES,
  cnhValidity,
  openRoutesRefusal,
  totalOpenRoutes,
  type CnhValidity,
  type OpenRouteCounts,
  type OpenRouteStatus,
};
