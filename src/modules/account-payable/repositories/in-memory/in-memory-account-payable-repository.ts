import { compareCodePoints } from "@/shared/pagination/in-memory-order";
import { afterCursor } from "@/shared/in-memory/cursor";
import { recordNotFound } from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { AccountPayableCategory } from "@prisma/client";

import { IAccountPayableRepository } from "../IAccount-payable-repository";

import { ACCOUNT_PAYABLE_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayablesProps,
  ListAccountPayablesResult,
  UpdateAccountPayable,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  ExportAccountPayablesProps,
} from "../../dtos/account-payable-dto";

import {
  ACCOUNT_PAYABLE_SORT_FALLBACK,
  amountOf,
  effectiveStatusGroups,
  type AccountPayableSortKey,
  type StatusGroupTotals,
} from "../../usecases/list-account-payable/account-payable-list";
import {
  accountPayableStatusGroupOf,
  accountPayableStatusOf,
  cents,
  type AccountPayableStatusGroup,
  type BusinessClock,
} from "../../rules/account-payable-status";

import { AccountPayableNotDeleteHasAlreadyPaidError } from "../../usecases/errors/account-payable-not-delete-has-already-paid-error";

import type { SortOrder } from "@/shared/pagination/list-query";

/** Each category's position in the Prisma enum, the order Postgres sorts by. */
const CATEGORY_POSITION = Object.fromEntries(
  Object.values(AccountPayableCategory).map((category, index) => [
    category,
    index,
  ]),
) as Record<AccountPayableCategory, number>;

const time = (value: Date | string | null | undefined): number | null =>
  value === null || value === undefined ? null : new Date(value).getTime();

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();

/** created_at desc, id desc: the Prisma tiebreaker, so pages cut the same. */
function newestFirst(a: AccountPayable, b: AccountPayable): number {
  const byCreated = (time(b.created_at) ?? 0) - (time(a.created_at) ?? 0);

  return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
}

/**
 * Postgres order: a NULL is last ascending and first descending unless the
 * order says `nulls: "last"` (payment date, amount paid, category).
 */
function compareNullable<T>(
  left: T | null,
  right: T | null,
  order: SortOrder,
  nullsLast: boolean,
  compare: (a: T, b: T) => number,
): number {
  if (left === null && right === null) return 0;

  const nullAfter = nullsLast || order === "asc";

  if (left === null) return nullAfter ? 1 : -1;
  if (right === null) return nullAfter ? -1 : 1;

  return (order === "asc" ? 1 : -1) * compare(left, right);
}

class InMemoryAccountPayableRepository implements IAccountPayableRepository {
  public accountPayables: AccountPayable[] = [];

  /**
   * What the real list reads through relations (search and sort). The twin
   * has no rows of those tables; tests seed the names they rely on.
   */
  public supplierNames = new Map<string, string>();
  public vehiclePlates = new Map<string, string>();
  public userNames = new Map<string, string>();
  public branchNames = new Map<string, string>();

  async createAccountPayable(
    accountPayableData: CreateAccountPayableProps,
  ): Promise<AccountPayable> {
    const accountPayable: AccountPayable = {
      ...ACCOUNT_PAYABLE_COLUMN_DEFAULTS,
      id: uuidV7(),
      issue_date: new Date(),
      due_date: accountPayableData.due_date,
      payment_date: accountPayableData.payment_date ?? null,
      amount: accountPayableData.amount.toString(),
      amount_paid: accountPayableData.amount_paid?.toString() ?? null,
      category: accountPayableData.category ?? null,
      category_description: accountPayableData.category_description ?? null,
      businessId: accountPayableData.businessId,
      branchId: accountPayableData.branchId,
      serviceOrderId: accountPayableData.serviceOrderId ?? null,
      registrationUserId: accountPayableData.registrationUserId,
      supplierId: accountPayableData.supplierId ?? null,
      vehicleId: accountPayableData.vehicleId ?? null,
      payee_name: accountPayableData.payee_name ?? null,
      description: accountPayableData.description ?? null,
      document_number: accountPayableData.document_number ?? null,
      createdById: accountPayableData.createdById ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.accountPayables.push(accountPayable);

    if (accountPayableData.client_submission_id) {
      this.submissions.set(
        `${accountPayableData.businessId}:${accountPayableData.client_submission_id}`,
        accountPayable.id,
      );
    }

    return accountPayable;
  }

  /** (businessId:key) → id, the unique index of the real table. */
  private submissions = new Map<string, string>();

  async findAccountPayableBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<AccountPayable | null> {
    const id = this.submissions.get(`${businessId}:${clientSubmissionId}`);

    return this.accountPayables.find((entry) => entry.id === id) ?? null;
  }

  private groupOf(
    bill: AccountPayable,
    clock: BusinessClock,
  ): AccountPayableStatusGroup {
    return accountPayableStatusGroupOf(accountPayableStatusOf(bill, clock));
  }

  /** Same fields and semantics as accountPayableListWhere's search. */
  private matchesSearch(bill: AccountPayable, search?: string): boolean {
    const term = search?.trim() ?? "";

    if (!term) return true;

    const needle = term.toLowerCase();
    const amount = amountOf(term);

    const texts = [
      bill.id,
      bill.serviceOrderId,
      bill.description,
      bill.document_number,
      bill.payee_name,
      bill.supplierId ? this.supplierNames.get(bill.supplierId) : null,
      bill.vehicleId ? this.vehiclePlates.get(bill.vehicleId) : null,
      this.userNames.get(bill.registrationUserId),
      this.branchNames.get(bill.branchId),
    ];

    return (
      texts.some((value) => lower(value).includes(needle)) ||
      (amount !== null &&
        (cents(bill.amount) === Math.round(amount * 100) ||
          (bill.amount_paid !== null &&
            bill.amount_paid !== undefined &&
            cents(bill.amount_paid) === Math.round(amount * 100))))
    );
  }

  /** Tenant, category and search: the base the cards are counted over. */
  private base(
    props: Omit<ListAccountPayablesProps, "page" | "pageSize">,
  ): AccountPayable[] {
    return this.accountPayables.filter(
      (bill) =>
        bill.businessId === props.businessId &&
        (!props.categories?.length ||
          (bill.category !== null &&
            bill.category !== undefined &&
            props.categories.includes(bill.category))) &&
        this.matchesSearch(bill, props.search),
    );
  }

  private ordered(
    rows: AccountPayable[],
    sort: AccountPayableSortKey | undefined,
    order: SortOrder | undefined,
  ): AccountPayable[] {
    const key = sort ?? ACCOUNT_PAYABLE_SORT_FALLBACK.sort;
    const direction =
      order ?? (sort ? "asc" : ACCOUNT_PAYABLE_SORT_FALLBACK.order);

    const byNumber = (a: number, b: number) => a - b;
    // Code point order, as Postgres sorts on the deployed image (in-memory-order).
    const byText = compareCodePoints;

    const compare = (a: AccountPayable, b: AccountPayable): number => {
      switch (key) {
        case "created_at":
        case "issue_date":
        case "due_date":
          return compareNullable(
            time(a[key]),
            time(b[key]),
            direction,
            false,
            byNumber,
          );
        case "payment_date":
          return compareNullable(
            time(a.payment_date),
            time(b.payment_date),
            direction,
            true,
            byNumber,
          );
        case "amount":
          return compareNullable(
            cents(a.amount),
            cents(b.amount),
            direction,
            false,
            byNumber,
          );
        case "amount_paid":
          return compareNullable(
            a.amount_paid === null || a.amount_paid === undefined
              ? null
              : cents(a.amount_paid),
            b.amount_paid === null || b.amount_paid === undefined
              ? null
              : cents(b.amount_paid),
            direction,
            true,
            byNumber,
          );
        case "category":
          // Postgres orders an enum by declaration (FUEL, MAINTENANCE, …,
          // FINES…), not alphabetically.
          return compareNullable(
            a.category ? CATEGORY_POSITION[a.category] : null,
            b.category ? CATEGORY_POSITION[b.category] : null,
            direction,
            true,
            byNumber,
          );
        case "supplier":
          return compareNullable(
            a.supplierId
              ? (this.supplierNames.get(a.supplierId) ?? null)
              : null,
            b.supplierId
              ? (this.supplierNames.get(b.supplierId) ?? null)
              : null,
            direction,
            false,
            byText,
          );
        case "vehicle":
          return compareNullable(
            a.vehicleId ? (this.vehiclePlates.get(a.vehicleId) ?? null) : null,
            b.vehicleId ? (this.vehiclePlates.get(b.vehicleId) ?? null) : null,
            direction,
            false,
            byText,
          );
      }
    };

    return [...rows].sort((a, b) => compare(a, b) || newestFirst(a, b));
  }

  async listAccountPayables({
    page,
    pageSize,
    sort,
    order,
    ...props
  }: ListAccountPayablesProps): Promise<ListAccountPayablesResult> {
    const base = this.base(props);
    const selected = effectiveStatusGroups(props.statusGroups);

    const matching = base.filter(
      (bill) => !selected || selected.includes(this.groupOf(bill, props.clock)),
    );

    const totals = (group: AccountPayableStatusGroup): StatusGroupTotals => {
      const rows = base.filter(
        (bill) => this.groupOf(bill, props.clock) === group,
      );

      return {
        count: rows.length,
        amount: rows.reduce((sum, bill) => sum + cents(bill.amount), 0) / 100,
        amountPaid:
          rows.reduce((sum, bill) => sum + cents(bill.amount_paid), 0) / 100,
      };
    };

    const skip = (page - 1) * pageSize;

    return {
      data: this.ordered(matching, sort, order).slice(skip, skip + pageSize),
      groups: {
        OPEN: totals("OPEN"),
        OVERDUE: totals("OVERDUE"),
        PAID: totals("PAID"),
      },
    };
  }

  async *streamAccountPayablesForExport({
    sort,
    order,
    ...props
  }: ExportAccountPayablesProps): AsyncGenerator<AccountPayable> {
    const selected = effectiveStatusGroups(props.statusGroups);

    const rows = this.base(props).filter(
      (bill) => !selected || selected.includes(this.groupOf(bill, props.clock)),
    );

    for (const row of this.ordered(rows, sort, order)) yield row;
  }

  async updateAccountPayable({
    accountPayableData,
    accountPayableId,
  }: UpdateAccountPayable): Promise<AccountPayable> {
    const index = this.accountPayables.findIndex(
      (payable) => payable.id === accountPayableId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    // Like Prisma: `undefined` is "not sent", `null` clears the column, the
    // company is never rewritten; money is kept as the Decimal's string.
    const changes = Object.fromEntries(
      Object.entries(accountPayableData)
        .filter(([key, value]) => value !== undefined && key !== "businessId")
        .map(([key, value]) =>
          (key === "amount" || key === "amount_paid") && value !== null
            ? [key, String(value)]
            : [key, value],
        ),
    );

    this.accountPayables[index] = {
      ...this.accountPayables[index],
      ...changes,
      updated_at: new Date(),
    } as AccountPayable;

    return this.accountPayables[index];
  }

  async deleteAccountPayable(
    accountPayableId: string,
    businessId: string,
  ): Promise<AccountPayable> {
    // Same precondition as the real `where`: this company, still unpaid.
    const index = this.accountPayables.findIndex(
      (payable) =>
        payable.id === accountPayableId &&
        payable.businessId === businessId &&
        !payable.payment_date,
    );

    if (index === -1) {
      throw new AccountPayableNotDeleteHasAlreadyPaidError();
    }

    return this.accountPayables.splice(index, 1)[0];
  }

  async findAccountPayableById(
    accountPayableId: string,
  ): Promise<AccountPayable | null> {
    return (
      this.accountPayables.find((payable) => payable.id === accountPayableId) ??
      null
    );
  }

  async findAccountPayablesByServiceOrderId(
    serviceOrderId: string,
  ): Promise<AccountPayable[] | null> {
    // findMany: an empty list, never null.
    return this.accountPayables.filter(
      (payable) => payable.serviceOrderId === serviceOrderId,
    );
  }

  async findAccountPayablesByRegistrationUserId(
    registrationUserId: string,
  ): Promise<AccountPayable[]> {
    return this.accountPayables.filter(
      (payable) => payable.registrationUserId === registrationUserId,
    );
  }

  async sumAmountByServiceOrderId(serviceOrderId: string): Promise<number> {
    return (
      this.accountPayables
        .filter((payable) => payable.serviceOrderId === serviceOrderId)
        .reduce((sum, payable) => sum + cents(payable.amount), 0) / 100
    );
  }

  async searchAccountPayableByResponsibleUserWithCursor({
    limit = 10,
    cursor,
    businessId,
    userId,
    search,
  }: SearchAccountPayableWithCursorProps): Promise<CursorPaginatedAccountPayable> {
    const term = search?.trim() ?? "";
    const needle = term.toLowerCase();
    const amount = term ? amountOf(term) : null;

    let filtered = this.accountPayables
      .filter(
        (payable) =>
          payable.registrationUserId === userId &&
          payable.businessId === businessId &&
          (!term ||
            [
              payable.id,
              payable.description,
              payable.document_number,
              payable.payee_name,
              payable.serviceOrderId,
              payable.supplierId
                ? this.supplierNames.get(payable.supplierId)
                : null,
              payable.vehicleId
                ? this.vehiclePlates.get(payable.vehicleId)
                : null,
            ].some((value) => lower(value).includes(needle)) ||
            (amount !== null &&
              cents(payable.amount) === Math.round(amount * 100))),
      )
      .sort(newestFirst);

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.accountPayables, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { InMemoryAccountPayableRepository };
