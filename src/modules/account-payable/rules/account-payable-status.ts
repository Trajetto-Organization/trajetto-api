import {
  businessDateKey,
  businessDayRange,
  businessDayStart,
  resolveTimeZone,
} from "@/shared/time/business-day";

/**
 * Where a bill stands, decided ONCE, on the server, by the company's business
 * day (decision 8.4, FLEET-AP-3).
 *
 * The web computed it in five places, comparing `now()` with the due date as
 * an instant. The form stores the due date as local midnight, so a bill
 * turned "Vencido" at 00:00 of the very day it was due — and each copy could
 * drift from the others. Here a bill is overdue only once its due DAY has
 * passed in the company's zone, and the list, the cards, the filter, the
 * driver's page and the export all read this answer.
 */

/** The label shown on the row. */
const ACCOUNT_PAYABLE_STATUSES = [
  "PENDING",
  "PARTIAL",
  "OVERDUE",
  "PARTIAL_LATE",
  "PAID",
  "LATE",
] as const;

type AccountPayableStatus = (typeof ACCOUNT_PAYABLE_STATUSES)[number];

/**
 * The three situations the cards count and the filter offers. Each status
 * falls in exactly one, so the three cards add up to the total:
 *   OPEN    — not fully paid, due day not passed (PENDING, PARTIAL)
 *   OVERDUE — not fully paid, due day passed    (OVERDUE, PARTIAL_LATE)
 *   PAID    — fully paid                         (PAID, LATE)
 * "Pago com atraso" is a paid bill; it used to be counted as paid AND overdue.
 */
const ACCOUNT_PAYABLE_STATUS_GROUPS = ["OPEN", "OVERDUE", "PAID"] as const;

type AccountPayableStatusGroup = (typeof ACCOUNT_PAYABLE_STATUS_GROUPS)[number];

const STATUS_GROUP: Record<AccountPayableStatus, AccountPayableStatusGroup> = {
  PENDING: "OPEN",
  PARTIAL: "OPEN",
  OVERDUE: "OVERDUE",
  PARTIAL_LATE: "OVERDUE",
  PAID: "PAID",
  LATE: "PAID",
};

/** "Today" for one company: its zone and the instant its day began. */
interface BusinessClock {
  timeZone: string;
  /** UTC instant at which today started in the company's zone. */
  todayStart: Date;
  todayKey: string;
}

function businessClock(
  timeZone: string | null | undefined,
  now: Date = new Date(),
): BusinessClock {
  const zone = resolveTimeZone(timeZone);

  return {
    timeZone: zone,
    todayStart: businessDayRange(now, zone).start,
    todayKey: businessDateKey(now, zone),
  };
}

type Money = number | string | { toString(): string } | null | undefined;

/** Money in cents: Decimal(10,2) columns compare exactly this way. */
function cents(value: Money): number {
  if (value === null || value === undefined) return 0;

  return Math.round(Number(value.toString()) * 100);
}

interface AccountPayableDates {
  amount: Money;
  amount_paid?: Money;
  due_date: Date | string;
  payment_date?: Date | string | null;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * The status of one bill.
 *
 * "Due day passed" is `due_date < todayStart`, which is exactly "the civil
 * day of the due date, in the company's zone, is before today": business
 * days partition the timeline, so an instant is before the start of today
 * iff its day is an earlier day. The SQL filter (accountPayableStatusWhere)
 * uses the same comparison, so a row never shows one status and filters as
 * another.
 */
function accountPayableStatusOf(
  bill: AccountPayableDates,
  clock: BusinessClock,
): AccountPayableStatus {
  const amount = cents(bill.amount);
  const paid = cents(bill.amount_paid);
  const due = asDate(bill.due_date);

  if (bill.amount_paid !== null && bill.amount_paid !== undefined && paid >= amount) {
    // Paid after the due DAY, compared as days: paying at 15h on the due
    // date is on time.
    const paidLate =
      bill.payment_date !== null &&
      bill.payment_date !== undefined &&
      businessDateKey(asDate(bill.payment_date), clock.timeZone) >
        businessDateKey(due, clock.timeZone);

    return paidLate ? "LATE" : "PAID";
  }

  const dueDayPassed = due.getTime() < clock.todayStart.getTime();

  if (dueDayPassed) return paid > 0 ? "PARTIAL_LATE" : "OVERDUE";

  return paid > 0 ? "PARTIAL" : "PENDING";
}

function accountPayableStatusGroupOf(
  status: AccountPayableStatus,
): AccountPayableStatusGroup {
  return STATUS_GROUP[status];
}

/** What every read of a bill adds to the row, computed here and nowhere else. */
interface AccountPayableSituation {
  status: AccountPayableStatus;
  status_group: AccountPayableStatusGroup;
  /** "YYYY-MM-DD" of the due date in the company's zone: show it as a day. */
  due_day: string;
  payment_day: string | null;
  /** amount − amount_paid, never negative. */
  remaining_amount: number;
}

function accountPayableSituation(
  bill: AccountPayableDates,
  clock: BusinessClock,
): AccountPayableSituation {
  const status = accountPayableStatusOf(bill, clock);

  return {
    status,
    status_group: accountPayableStatusGroupOf(status),
    due_day: businessDateKey(asDate(bill.due_date), clock.timeZone),
    payment_day: bill.payment_date
      ? businessDateKey(asDate(bill.payment_date), clock.timeZone)
      : null,
    remaining_amount:
      Math.max(0, cents(bill.amount) - cents(bill.amount_paid)) / 100,
  };
}

/** The row as every read returns it: the columns plus the situation. */
function withSituation<T extends AccountPayableDates>(
  bill: T,
  clock: BusinessClock,
): T & AccountPayableSituation {
  return { ...bill, ...accountPayableSituation(bill, clock) };
}

/**
 * The clock of a company row. `timezone` is read loosely because the
 * Business DTO does not name the column yet; the row carries it.
 */
function businessClockOf(
  business: object | null | undefined,
  now: Date = new Date(),
): BusinessClock {
  return businessClock(
    (business as { timezone?: string | null } | null | undefined)?.timezone,
    now,
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant stored for a due or payment date the form sends.
 *
 * The form picks a DAY and sends "YYYY-MM-DD"; it is stored as the instant
 * that day starts in the company's zone — what the legacy form stored for
 * São Paulo (local midnight), so old and new rows read the same. A full ISO
 * instant (older clients) is kept as it is.
 */
function billDateFromInput(value: string | Date, timeZone: string): Date {
  if (value instanceof Date) return value;

  return DATE_ONLY.test(value)
    ? businessDayStart(value, resolveTimeZone(timeZone))
    : new Date(value);
}

export {
  ACCOUNT_PAYABLE_STATUSES,
  ACCOUNT_PAYABLE_STATUS_GROUPS,
  accountPayableSituation,
  accountPayableStatusGroupOf,
  accountPayableStatusOf,
  billDateFromInput,
  businessClock,
  businessClockOf,
  cents,
  withSituation,
  type AccountPayableSituation,
  type AccountPayableStatus,
  type AccountPayableStatusGroup,
  type BusinessClock,
};
