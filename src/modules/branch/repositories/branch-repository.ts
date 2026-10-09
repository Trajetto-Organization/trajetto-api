import { Prisma } from "@prisma/client";

import { IBranchRepository } from "./IBranch-repository";
import {
  Branch,
  CreateBranchProps,
  ListAllBranchesProps,
  ListBranchProps,
  UpdateBranch,
  SearchBranchWithCursorProps,
  CursorPaginatedBranch,
} from "../dtos/branch-dto";

import database from "@/../infra/database";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

import {
  BRANCH_SORT,
  branchListWhere,
} from "../usecases/list-branch/branch-list";
import { blankOptionalsToNull } from "./branch-columns";

class BranchRepository implements IBranchRepository {
  constructor(private prisma = database) {}

  async toggleBranchActive(
    branchId: string,
    expectedActive: boolean,
  ): Promise<Branch | null> {
    return this.prisma.$transaction(async (transaction) => {
      const { count } = await transaction.branch.updateMany({
        where: { id: branchId, is_active: expectedActive },
        data: { is_active: !expectedActive },
      });

      if (count === 0) return null;

      return transaction.branch.findUnique({ where: { id: branchId } });
    });
  }

  async createBranch(
    branchData: CreateBranchProps,
    tx?: Prisma.TransactionClient,
  ): Promise<Branch> {
    const branchCreated = await (tx ?? this.prisma).branch.create({
      data: {
        ...branchData,
        ...blankOptionalsToNull(branchData),
      },
    });

    return branchCreated;
  }

  /**
   * One company's page ‖ the (is_active, uf) breakdown, then the trade-name
   * count: at most two connections at a time (connection-fan-out budget).
   */
  async listAllBranches({
    page,
    pageSize,
    businessId,
    search,
    statuses,
    ufs,
    sort,
    order,
  }: ListAllBranchesProps): Promise<ListBranchProps> {
    const filters = { businessId, search, statuses, ufs };

    const [data, grouped] = await Promise.all([
      this.prisma.branch.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: branchListWhere(filters),
        orderBy: resolveOrderBy(BRANCH_SORT, { sort, order }),
      }),
      this.prisma.branch.groupBy({
        by: ["is_active", "uf"],
        where: branchListWhere(filters, { except: "facets" }),
        _count: { _all: true, erp_code: true },
      }),
    ]);

    // A blank trade name is not a trade name; a GROUP BY count cannot tell.
    const withFantasyName = await this.prisma.branch.count({
      where: {
        AND: [
          branchListWhere(filters),
          { fantasy_name: { not: null } },
          { NOT: { fantasy_name: "" } },
        ],
      },
    });

    return {
      data,
      groups: grouped.map((group) => ({
        is_active: group.is_active,
        uf: group.uf,
        count: group._count._all,
        withErpCode: group._count.erp_code,
      })),
      withFantasyName,
    };
  }

  async updateBranch(
    { branchData, branchId }: UpdateBranch,
    tx?: Prisma.TransactionClient,
  ): Promise<Branch> {
    // Only what the caller sent: a partial update used to write
    // `erp_code: null` and `complement: null` whenever those keys were
    // absent, silently erasing them.
    const filteredData = Object.fromEntries(
      Object.entries(branchData).filter(([_, value]) => value !== undefined),
    );

    const updatedBranch = await (tx ?? this.prisma).branch.update({
      where: {
        id: branchId,
      },
      data: {
        ...filteredData,
        ...blankOptionalsToNull(filteredData),
      },
    });

    return updatedBranch;
  }

  async findBranchById(branchId: string): Promise<Branch | null> {
    const branch = await this.prisma.branch.findUnique({
      where: {
        id: branchId,
      },
    });

    return branch;
  }

  /**
   * Inside ONE company. The ERP code is the customer's own numbering ("001",
   * "MATRIZ"), unique per company since 20260924090400_tenant_scoped_uniques;
   * looked up globally, the first carrier to type "001" blocked every other.
   */
  async findBranchByErpCode(
    businessId: string,
    erp_code: string,
  ): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        businessId,
        erp_code,
      },
    });

    return branch;
  }

  async findBranchByEmail(
    businessId: string,
    email: string,
  ): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        businessId,
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        email: insensitiveEquals(email),
      },
    });

    return branch;
  }

  async findBranchByCnpj(cnpj: string): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        cnpj,
      },
    });

    return branch;
  }

  async findBranchByCorporateReason(
    businessId: string,
    corporate_reason: string,
  ): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        businessId,
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        corporate_reason: insensitiveEquals(corporate_reason),
      },
    });

    return branch;
  }

  async deleteBranch(branchId: string): Promise<Branch> {
    const deletedBranch = await this.prisma.branch.delete({
      where: {
        id: branchId,
      },
    });

    return deletedBranch;
  }

  async searchBranchWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchBranchWithCursorProps): Promise<CursorPaginatedBranch> {
    const items = await this.prisma.branch.findMany({
      where: {
        businessId,
        is_active: true,
        ...(search &&
          buildSearchOr([
            { corporate_reason: { contains: search, mode: "insensitive" } },
            { fantasy_name: { contains: search, mode: "insensitive" } },
            { cnpj: { contains: search, mode: "insensitive" } },
            { city: { contains: search, mode: "insensitive" } },
            { uf: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ])),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      // The id breaks created_at ties: a cursor over an unstable order skips
      // or repeats rows between pages.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countBranchDependencies(
    branchId: string,
  ): Promise<Record<string, number>> {
    // One statement, seven scalar sub-selects: one connection and one round
    // trip. Seven parallel counts held seven of the replica's ten connections
    // (tests/E2E/query-plans-connections.test.ts); seven sequential ones paid
    // seven round trips. Each sub-select is an index probe on branchId.
    const [row] = await this.prisma.$queryRaw<
      Array<Record<"vehicles" | "drivers" | "serviceOrders" | "accountsPayable" | "fines" | "fuels" | "vehicleChecklists", bigint>>
    >`
      SELECT
        (SELECT count(*) FROM "vehicle" WHERE "branchId" = ${branchId}) AS "vehicles",
        (SELECT count(*) FROM "driver" WHERE "branchId" = ${branchId}) AS "drivers",
        (SELECT count(*) FROM "service_order" WHERE "branchId" = ${branchId}) AS "serviceOrders",
        (SELECT count(*) FROM "account_payable" WHERE "branchId" = ${branchId}) AS "accountsPayable",
        (SELECT count(*) FROM "fine" WHERE "branchId" = ${branchId}) AS "fines",
        (SELECT count(*) FROM "fuel" WHERE "branchId" = ${branchId}) AS "fuels",
        (SELECT count(*) FROM "vehicle_checklist" WHERE "branchId" = ${branchId}) AS "vehicleChecklists"
    `;

    return {
      vehicles: Number(row.vehicles),
      drivers: Number(row.drivers),
      serviceOrders: Number(row.serviceOrders),
      accountsPayable: Number(row.accountsPayable),
      fines: Number(row.fines),
      fuels: Number(row.fuels),
      vehicleChecklists: Number(row.vehicleChecklists),
    };
  }
}

export { BranchRepository };
