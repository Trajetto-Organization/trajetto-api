import { AppError } from "@/shared/errors/AppError";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import { pickedDateFromInput, pickedDayKey } from "@/shared/vehicle/record-dates";

/**
 * A checklist dated after the company's today (decision 1.2).
 *
 * The create schema compared with the server's end of day
 * (`setHours(23, 59, 59, 999)` in a UTC container): from 21:00 in São Paulo
 * — 20:00 in Manaus — the next day already passed as "today". The edit had no
 * check at all. Today is the company's, from Business.timezone.
 *
 * The checklist's own day follows the rule every reader applies
 * (shared/vehicle/record-dates pickedDayKey): the web's local midnight and
 * the app's inspection moment are instants, read in the company's zone; a
 * bare "YYYY-MM-DD" is stored as 00:00 UTC and IS that day. Read as an
 * instant, 00:00 UTC of tomorrow is still this evening in Brazil, so a
 * date-only tomorrow passed and was then shown as tomorrow.
 */
function isChecklistDateInTheFuture(
  checklistDate: Date | string,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  const date = new Date(checklistDate);

  if (Number.isNaN(date.getTime())) return false;

  return pickedDayKey(date, timeZone) > businessDateKey(now, timeZone);
}

function assertChecklistNotInTheFuture(
  checklistDate: Date | string | null | undefined,
  business: { timezone?: string | null },
  now: Date = new Date(),
): void {
  if (checklistDate === undefined || checklistDate === null || checklistDate === "") {
    return;
  }

  const timeZone = resolveTimeZone(business.timezone ?? undefined);

  if (isChecklistDateInTheFuture(checklistDate, timeZone, now)) {
    throw new AppError(
      "A data do checklist não pode ser no futuro.",
      400,
      "CHECKLIST_DATE_IN_FUTURE",
    );
  }
}

/**
 * What an edit re-points (FLEET-FUEL-1, the checklist half).
 *
 * A past inspection keeps its driver and branch after the driver leaves or
 * the branch closes; "the driver must be active" is about a NEW checklist.
 * The web form resent every link unchanged, so correcting a note on last
 * month's checklist of a driver who has since left was refused. The current
 * state is checked only for a link the edit actually changes.
 */
function changedChecklistLinks(
  current: { vehicleId: string; driverId: string; branchId: string },
  next: { vehicleId?: string | null; driverId?: string | null; branchId?: string | null },
): { vehicle: boolean; driver: boolean; branch: boolean } {
  const differs = (value: string | null | undefined, original: string) =>
    typeof value === "string" && value !== "" && value !== original;

  return {
    vehicle: differs(next.vehicleId, current.vehicleId),
    driver: differs(next.driverId, current.driverId),
    branch: differs(next.branchId, current.branchId),
  };
}

/**
 * Whether an edit moves the checklist in time. A resent date equal to the
 * stored instant is not a move: the web posts the date field back untouched
 * on every edit.
 */
function checklistDateMoved(
  stored: Date | string,
  next: Date | string | null | undefined,
): boolean {
  if (next === undefined || next === null || next === "") return false;

  const nextTime = new Date(next).getTime();

  return !Number.isNaN(nextTime) && nextTime !== new Date(stored).getTime();
}

/**
 * The checklist date as the column wants it. The schemas accept a day or an
 * instant, and Prisma's DateTime refuses a bare `2026-09-17` ("premature end
 * of input"): an API client sending the date-only form got a 500. A day is
 * the instant it starts in the company's zone (pickedDateFromInput); read as
 * 00:00 UTC it was the evening before in Brazil, placed before the same
 * day's readings, and a valid km was refused.
 */
function withChecklistDate<T extends { checklist_date?: Date | string | null }>(
  data: T,
  timeZone: string | null | undefined,
): T {
  if (typeof data.checklist_date !== "string" || data.checklist_date === "") {
    return data;
  }

  const picked = pickedDateFromInput(data.checklist_date, timeZone);

  return { ...data, checklist_date: picked instanceof Date ? picked : new Date(picked) };
}

export {
  assertChecklistNotInTheFuture,
  withChecklistDate,
  changedChecklistLinks,
  checklistDateMoved,
  isChecklistDateInTheFuture,
};
