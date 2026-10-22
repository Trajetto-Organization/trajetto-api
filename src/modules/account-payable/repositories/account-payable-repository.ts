import { IAccountPayableRepository } from "./IAccount-payable-repository";
import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayablesProps,
  ListAccountPayablesResult,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  UpdateAccountPayable,
  ExportAccountPayablesProps,
} from "../dtos/account-payable-dto";

import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  ACCOUNT_PAYABLE_SORT,
  accountPayableListWhere,
  amountOf,
  type StatusGroupTotals,
} from "../usecases/list-account-payable/account-payable-list";

import { AccountPayableNotDeleteHasAlreadyPaidError } from "../usecases/errors/account-payable-not-delete-has-already-paid-error";

/**
 * What every read of a bill carries: the names a row shows, never the whole
 * related records (a user row holds a password hash; a branch, an address).
 */
const ACCOUNT_PAYABLE_INCLUDE = {
  branch: { select: { id: true, corporate_reason: true, fantasy_name: true } },
  serviceOrder: {
    select: {
      id: true,
      date: true,
      maintenance_type: true,
      vehicle: { select: { license_plate: true, description: true } },
    },
  },
  registrationUser: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  vehicle: { select: { id: true, license_plate: true, description: true } },
} satisfies Prisma.AccountPayableInclude;

const EXPORT_BATCH_SIZE = 1000;

class AccountPayableRepository implements IAccountPayableRepository {
  constructor(private prisma = database) {}

  // `tx` lets the use case create the bill and its outbox event atomically.
  async createAccountPayable(
    accountPayableData: CreateAccountPayableProps,
    tx?: Prisma.TransactionClient,
  ): Promise<AccountPayable> {
    const client = tx ?? this.prisma;

    return client.accountPayable.create({
      data: {
        due_date: accountPayableData.due_date,
        payment_date: accountPayableData.payment_date,
        amount: accountPayableData.amount,
        amount_paid: accountPayableData.amount_paid,
        category: accountPayableData.category,
        category_description: accountPayableData.category_description,
        client_submission_id: accountPayableData.client_submission_id ?? null,
        payee_name: accountPayableData.payee_name ?? null,
        description: accountPayableData.description ?? null,
        document_number: accountPayableData.document_number ?? null,
        business: { connect: { id: accountPayableData.businessId } },
        branch: { connect: { id: accountPayableData.branchId } },
        ...(accountPayableData.serviceOrderId && {
          serviceOrder: { connect: { id: accountPayableData.serviceOrderId } },
        }),
        ...(accountPayableData.supplierId && {
          supplier: { connect: { id: accountPayableData.supplierId } },
        }),
        ...(accountPayableData.vehicleId && {
          vehicle: { connect: { id: accountPayableData.vehicleId } },
        }),
        ...(accountPayableData.createdById && {
          createdBy: { connect: { id: accountPayableData.createdById } },
        }),
        registrationUser: {
          connect: { id: accountPayableData.registrationUserId },
        },
      },
      include: ACCOUNT_PAYABLE_INCLUDE,
    });
  }

  async findAccountPayableBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<AccountPayable | null> {
    // The unique (businessId, client_submission_id) index answers this.
    return this.prisma.accountPayable.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: clientSubmissionId,
        },
      },
      include: ACCOUNT_PAYABLE_INCLUDE,
    });
  }

  async listAccountPayables({
    page,
    pageSize,
    sort,
    order,
    clock,
    ...filters
  }: ListAccountPayablesProps): Promise<ListAccountPayablesResult> {
    const context = {
      todayStart: clock.todayStart,
      amountRef: this.prisma.accountPayable.fields.amount,
    };

    // The card total of one situation over the base (every filter but the
    // status one): its rows and its money in one aggregate.
    const groupTotals = async (
      group: "OPEN" | "OVERDUE" | "PAID",
    ): Promise<StatusGroupTotals> => {
      const result = await this.prisma.accountPayable.aggregate({
        where: accountPayableListWhere(filters, {
          ...context,
          withStatus: false,
          onlyGroup: group,
        }),
        _count: { _all: true },
        _sum: { amount: true, amount_paid: true },
      });

      return {
        count: result._count._all,
        amount: Number(result._sum.amount ?? 0),
        amountPaid: Number(result._sum.amount_paid ?? 0),
      };
    };

    // Two at a time, the budget of a list screen (connection-fan-out): the
    // page beside the first total, then the other two.
    const [data, paid] = await Promise.all([
      this.prisma.accountPayable.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: accountPayableListWhere(filters, {
          ...context,
          withStatus: true,
        }),
        orderBy: resolveOrderBy(ACCOUNT_PAYABLE_SORT, { sort, order }),
        include: ACCOUNT_PAYABLE_INCLUDE,
      }),
      groupTotals("PAID"),
    ]);

    const [open, overdue] = await Promise.all([
      groupTotals("OPEN"),
      groupTotals("OVERDUE"),
    ]);

    return { data, groups: { OPEN: open, OVERDUE: overdue, PAID: paid } };
  }

  async *streamAccountPayablesForExport({
    sort,
    order,
    clock,
    ...filters
  }: ExportAccountPayablesProps): AsyncGenerator<AccountPayable> {
    const where = accountPayableListWhere(filters, {
      todayStart: clock.todayStart,
      amountRef: this.prisma.accountPayable.fields.amount,
      withStatus: true,
    });

    const orderBy = resolveOrderBy(ACCOUNT_PAYABLE_SORT, { sort, order });
    let cursor: string | undefined;

    // Keyset over the list's own order (the id tiebreaker makes it total),
    // one batch in memory at a time.
    while (true) {
      const batch = await this.prisma.accountPayable.findMany({
        where,
        orderBy,
        include: ACCOUNT_PAYABLE_INCLUDE,
        take: EXPORT_BATCH_SIZE,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
      });

      for (const row of batch) yield row;

      if (batch.length < EXPORT_BATCH_SIZE) return;

      cursor = batch[batch.length - 1].id;
    }
  }

  async updateAccountPayable(
    { accountPayableData, accountPayableId }: UpdateAccountPayable,
    tx?: Prisma.TransactionClient,
  ): Promise<AccountPayable> {
    const client = tx ?? this.prisma;

    // `undefined` = not sent. The company is never written: a bill moved to
    // another company would keep its branch, supplier and vehicle behind.
    const filteredData = Object.fromEntries(
      Object.entries(accountPayableData).filter(
        ([key, value]) => value !== undefined && key !== "businessId",
      ),
    );

    return client.accountPayable.update({
      where: { id: accountPayableId },
      data: filteredData,
      include: ACCOUNT_PAYABLE_INCLUDE,
    });
  }

  async deleteAccountPayable(
    accountPayableId: string,
    businessId: string,
  ): Promise<AccountPayable> {
    /**
     * The unpaid bill of this company, or nothing.
     *
     * `deleteMany`, not `delete`: `delete` needs a unique key and throws
     * P2025 when the `where` misses, and missing is a legitimate answer here
     * — the bill was paid in the meantime. The read before it only exists to
     * return what was deleted, as the contract promises.
     */
    const found = await this.prisma.accountPayable.findFirst({
      where: { id: accountPayableId, businessId, payment_date: null },
    });

    if (!found) {
      throw new AccountPayableNotDeleteHasAlreadyPaidError();
    }

    const { count } = await this.prisma.accountPayable.deleteMany({
      where: { id: accountPayableId, businessId, payment_date: null },
    });

    // Zero means someone stamped the payment between the read above and this
    // line. Nothing was deleted, and the caller has to know it.
    if (count === 0) {
      throw new AccountPayableNotDeleteHasAlreadyPaidError();
    }

    return found;
  }

  async findAccountPayableById(
    accountPayableId: string,
  ): Promise<AccountPayable | null> {
    return this.prisma.accountPayable.findUnique({
      where: { id: accountPayableId },
      include: ACCOUNT_PAYABLE_INCLUDE,
    });
  }

  async findAccountPayablesByServiceOrderId(
    serviceOrderId: string,
  ): Promise<AccountPayable[] | null> {
    return this.prisma.accountPayable.findMany({ where: { serviceOrderId } });
  }

  async findAccountPayablesByRegistrationUserId(
    registrationUserId: string,
  ): Promise<AccountPayable[]> {
    return this.prisma.accountPayable.findMany({
      where: { registrationUserId },
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        serviceOrder: {
          select: {
            id: true,
            date: true,
            vehicle: { select: { license_plate: true } },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
  }

  async sumAmountByServiceOrderId(serviceOrderId: string): Promise<number> {
    const result = await this.prisma.accountPayable.aggregate({
      where: { serviceOrderId },
      _sum: { amount: true },
    });

    return Number(result._sum.amount ?? 0);
  }

  async searchAccountPayableByResponsibleUserWithCursor({
    limit = 10,
    cursor,
    businessId,
    userId,
    search,
  }: SearchAccountPayableWithCursorProps): Promise<CursorPaginatedAccountPayable> {
    const term = search?.trim() ?? "";
    const amount = term ? amountOf(term) : null;

    const items = await this.prisma.accountPayable.findMany({
      where: {
        // Self-scoped: the bills this user answers for, in this company.
        registrationUserId: userId,
        businessId,
        ...(term &&
          buildSearchOr<Prisma.AccountPayableWhereInput>([
            { id: { contains: term, mode: "insensitive" } },
            { description: { contains: term, mode: "insensitive" } },
            { document_number: { contains: term, mode: "insensitive" } },
            { payee_name: { contains: term, mode: "insensitive" } },
            { supplier: { name: { contains: term, mode: "insensitive" } } },
            {
              vehicle: {
                license_plate: { contains: term, mode: "insensitive" },
              },
            },
            { serviceOrderId: { contains: term, mode: "insensitive" } },
            ...(amount !== null ? [{ amount }] : []),
          ])),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      include: ACCOUNT_PAYABLE_INCLUDE,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { AccountPayableRepository, ACCOUNT_PAYABLE_INCLUDE };
