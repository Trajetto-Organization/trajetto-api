import { Prisma } from "@prisma/client";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";

import { IBusinessRepository } from "./IBusiness-repository";
import {
  Business,
  CreateBusinessProps,
  CursorPaginatedBusiness,
  ListBusinessByBusinessIdProps,
  ListBusinessProps,
  SearchBusinessWithCursorProps,
  UpdateBusiness,
} from "../dtos/business-dto";
import {
  BUSINESS_SORT,
  TOP_PLACES,
  businessListWhere,
  cityLabel,
} from "../usecases/list-business/business-list";

import database, { databaseRead } from "@/../infra/database";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";
import { deleteQueueRowsOfBusiness } from "@/shared/notifications/queue-row-cleanup";

class BusinessRepository implements IBusinessRepository {
  constructor(private prisma = database) {}

  /**
   * The heavy reads' bulkhead (plano-escala F3-17), for the MASTER's list of
   * companies: a pool of its own, 3 connections and 10 s a statement, so a
   * burst of them waits among itself instead of taking the connections every
   * other request needs. A repository built on another client (a test's) reads
   * on that client. A getter, so a module that mocks infra/database without it
   * only needs it when one of these reads runs.
   */
  private get read(): typeof this.prisma {
    return this.prisma === database ? databaseRead : this.prisma;
  }

  async createBusiness(
    businessData: CreateBusinessProps,
    outerTx?: Prisma.TransactionClient,
  ): Promise<Business> {
    // The company and its default occurrence types (decisions 14.3 and
    // 14.4: "Entrega normal" and the three pause types) commit together, so
    // the installed app's proof and pause always find their type.
    const create = async (tx: Prisma.TransactionClient) => {
      const businessCreated = await tx.business.create({
        data: {
          ...businessData,
          erp_code: businessData.erp_code || null,
          complement: businessData.complement || null,

          // Every new company starts with the fleet module — it is the base
          // product; additional modules are toggled by the master afterwards.
          entitlements: {
            create: { module: "FLEET", enabled: true },
          },
        },
      });

      await ensureDefaultOccurrenceTypes(tx, businessCreated.id);

      return businessCreated;
    };

    // Prisma has no nested interactive transactions: join the caller's.
    return outerTx ? create(outerTx) : this.prisma.$transaction(create);
  }

  /**
   * One page of companies ‖ the (is_active, uf) breakdown, then the top
   * cities ‖ the page's fleet sizes: at most two connections at a time
   * (connection-fan-out budget). The cards and filters are derived from the
   * breakdowns, never from the page (decision 8.8).
   */
  async listBusiness({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
    statuses,
    ufs,
    sort,
    order,
  }: ListBusinessByBusinessIdProps): Promise<ListBusinessProps> {
    const filters = {
      search,
      statuses,
      ufs,
      ...(currentUserRole !== "MASTER" && { ownBusinessId: businessId }),
    };

    const [businessRows, grouped] = await Promise.all([
      this.read.business.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: businessListWhere(filters),
        orderBy: resolveOrderBy(BUSINESS_SORT, { sort, order }),
      }),
      this.read.business.groupBy({
        by: ["is_active", "uf"],
        where: businessListWhere(filters, { except: "facets" }),
        _count: { _all: true, erp_code: true },
      }),
    ]);

    const pageIds = businessRows.map((business) => business.id);

    const [cities, fleets] = await Promise.all([
      // By city AND state: two "São José" (SC and SP) are two places.
      this.read.business.groupBy({
        by: ["city", "uf"],
        where: businessListWhere(filters),
        _count: { _all: true },
        orderBy: [{ _count: { city: "desc" } }, { city: "asc" }, { uf: "asc" }],
        take: TOP_PLACES,
      }),
      // The page's fleets only — active fleet, INACTIVE vehicles free their
      // slot. Not a filtered relation `_count` on the page: Prisma writes it
      // as a LEFT JOIN on a subselect grouped over EVERY vehicle of the
      // platform (a sequential scan of 10.000 vehicles for a page of ten in
      // tests/E2E/query-plans.test.ts), which grows with every carrier.
      pageIds.length > 0
        ? this.read.vehicle.groupBy({
            by: ["businessId"],
            where: {
              businessId: { in: pageIds },
              status: { not: "INACTIVE" },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const fleetOf = new Map(
      fleets.map((fleet) => [fleet.businessId, fleet._count._all]),
    );

    // The registered fleet size next to the contracted limit (vehicle_limit).
    const data = businessRows.map((business) => ({
      ...business,
      vehicle_count: fleetOf.get(business.id) ?? 0,
    }));

    return {
      data,
      groups: grouped.map((group) => ({
        is_active: group.is_active,
        uf: group.uf,
        count: group._count._all,
        withErpCode: group._count.erp_code,
      })),
      topCities: cities.map((place) => ({
        value: cityLabel(place.city, place.uf),
        count: place._count._all,
      })),
    };
  }

  async searchBusinessWithCursor({
    limit = 10,
    cursor,
    businessId,
    currentUserRole,
    search,
  }: SearchBusinessWithCursorProps): Promise<CursorPaginatedBusiness> {
    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { id: businessId }),
      is_active: true,
      ...(search &&
        buildSearchOr([
          {
            corporate_reason: {
              contains: search,
              mode: "insensitive" as const,
            },
          },
          { fantasy_name: { contains: search, mode: "insensitive" as const } },
          { cnpj: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          {
            responsible_name: {
              contains: search,
              mode: "insensitive" as const,
            },
          },
        ])),
    };

    const businesses = await this.prisma.business.findMany({
      where: whereCondition,
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      // The id breaks created_at ties: a cursor over an unstable order skips
      // or repeats rows between pages.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = businesses.length > limit;

    const data = hasMore ? businesses.slice(0, limit) : businesses;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async toggleBusinessActive(
    businessId: string,
    expectedActive: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<Business | null> {
    const toggle = async (transaction: Prisma.TransactionClient) => {
      // Never a company whose purge was scheduled (F3-25): its way back is
      // the reactivation, which also cancels the purge.
      const { count } = await transaction.business.updateMany({
        where: { id: businessId, is_active: expectedActive, purge_state: null },
        data: { is_active: !expectedActive },
      });

      if (count === 0) return null;

      return transaction.business.findUnique({ where: { id: businessId } });
    };

    // The caller's transaction when it has one (the audit entry joins it).
    return tx ? toggle(tx) : this.prisma.$transaction(toggle);
  }

  async schedulePurge(
    businessId: string,
    purgeAfter: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<Business | null> {
    const client = tx ?? this.prisma;
    const { count } = await client.business.updateMany({
      where: { id: businessId, purge_state: null },
      data: {
        is_active: false,
        deactivated_at: new Date(),
        purge_state: "SCHEDULED",
        purge_after: purgeAfter,
      },
    });

    if (count === 0) return null;

    return client.business.findUnique({
      where: { id: businessId },
    }) as Promise<Business | null>;
  }

  async cancelPurge(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Business | null> {
    const client = tx ?? this.prisma;
    const { count } = await client.business.updateMany({
      where: { id: businessId, purge_state: "SCHEDULED" },
      data: {
        is_active: true,
        deactivated_at: null,
        purge_state: null,
        purge_after: null,
      },
    });

    if (count === 0) return null;

    return client.business.findUnique({
      where: { id: businessId },
    }) as Promise<Business | null>;
  }

  async findScheduledPurges(from: Date, to: Date): Promise<Business[]> {
    return this.prisma.business.findMany({
      where: { purge_state: "SCHEDULED", purge_after: { gte: from, lt: to } },
      orderBy: { purge_after: "asc" },
    }) as Promise<Business[]>;
  }

  async updateBusiness(
    { businessData, businessId }: UpdateBusiness,
    tx?: Prisma.TransactionClient,
  ): Promise<Business> {
    const filteredData = Object.fromEntries(
      Object.entries(businessData).filter(([_, value]) => value !== undefined),
    );

    const updateBusiness = await (tx ?? this.prisma).business.update({
      where: {
        id: businessId,
      },
      data: filteredData,
    });

    return updateBusiness;
  }

  async deleteBusiness(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Business> {
    // Its queue rows first, in the same transaction: the cascade that takes
    // them today leaves with wave 10 (queue-row-cleanup.ts). A delete that
    // fails (P2025, a RESTRICT key) rolls them back with it.
    const remove = async (client: Prisma.TransactionClient) => {
      await deleteQueueRowsOfBusiness(client, businessId);

      return client.business.delete({ where: { id: businessId } });
    };

    return tx ? remove(tx) : this.prisma.$transaction(remove);
  }

  async findBusinessById(businessId: string): Promise<Business | null> {
    const findBusinessById = await this.prisma.business.findUnique({
      where: {
        id: businessId,
      },
    });

    return findBusinessById;
  }

  async findBusinessByCnpj(cnpj: string): Promise<Business | null> {
    const findBusinessByCnpj = await this.prisma.business.findUnique({
      where: {
        cnpj: cnpj,
      },
    });

    return findBusinessByCnpj;
  }

  async findBusinessByCorporateReason(
    corporateReason: string,
  ): Promise<Business | null> {
    const findBusinessByCorporateReason = await this.prisma.business.findFirst({
      where: {
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        corporate_reason: insensitiveEquals(corporateReason),
      },
    });

    return findBusinessByCorporateReason;
  }

  async findBusinessByErpcode(erpCode: string): Promise<Business | null> {
    const findBusinessByErpcode = await this.prisma.business.findFirst({
      where: {
        erp_code: insensitiveEquals(erpCode),
      },
    });

    return findBusinessByErpcode;
  }

  async findBusinessByEmail(email: string): Promise<Business | null> {
    const findBusinessByEmail = await this.prisma.business.findFirst({
      where: {
        email: insensitiveEquals(email),
      },
    });

    return findBusinessByEmail;
  }

  async updateVehicleLimit(
    businessId: string,
    vehicle_limit: number,
    tx?: Prisma.TransactionClient,
  ): Promise<Business> {
    // Lowering the limit below the current fleet never deletes vehicles —
    // it only blocks new registrations (checked at create-vehicle time).
    const updatedBusiness = await (tx ?? this.prisma).business.update({
      where: { id: businessId },
      data: { vehicle_limit },
    });

    return updatedBusiness;
  }

  async updateAILimit(
    businessId: string,
    ai_analysis_limit: number,
    tx?: Prisma.TransactionClient,
  ): Promise<Business> {
    // Consumption lives in the AIUsagePeriod ledger and is never rewritten:
    // lowering the limit below what was already spent simply leaves zero
    // remaining for the rest of the period.
    const updatedBusiness = await (tx ?? this.prisma).business.update({
      where: { id: businessId },
      data: { ai_analysis_limit },
    });

    return updatedBusiness;
  }

  async findAIUsage(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        corporate_reason: true,
        fantasy_name: true,
        ai_analysis_limit: true,
      },
    });

    return business;
  }

  async countBusinessDependencies(
    businessId: string,
  ): Promise<{ branches: number; users: number; drivers: number }> {
    const [branches, users, drivers] = await Promise.all([
      this.prisma.branch.count({ where: { businessId } }),
      this.prisma.user.count({ where: { businessId } }),
      this.prisma.driver.count({ where: { businessId } }),
    ]);

    return { branches, users, drivers };
  }
}

export { BusinessRepository };
