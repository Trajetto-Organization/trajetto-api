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

import database from "@/../infra/database";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

class BusinessRepository implements IBusinessRepository {
  constructor(private prisma = database) {}

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
   * cities: at most two connections at a time (connection-fan-out budget).
   * The cards and filters are derived from the breakdowns, never from the
   * page (decision 8.8).
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
      this.prisma.business.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: businessListWhere(filters),
        orderBy: resolveOrderBy(BUSINESS_SORT, { sort, order }),
        include: {
          _count: {
            // Active fleet only — INACTIVE vehicles free their slot.
            select: {
              vehicles: { where: { status: { not: "INACTIVE" } } },
            },
          },
        },
      }),
      this.prisma.business.groupBy({
        by: ["is_active", "uf"],
        where: businessListWhere(filters, { except: "facets" }),
        _count: { _all: true, erp_code: true },
      }),
    ]);

    // By city AND state: two "São José" (SC and SP) are two places.
    const cities = await this.prisma.business.groupBy({
      by: ["city", "uf"],
      where: businessListWhere(filters),
      _count: { _all: true },
      orderBy: [{ _count: { city: "desc" } }, { city: "asc" }, { uf: "asc" }],
      take: TOP_PLACES,
    });

    // Flatten the relation count so the API exposes registered fleet size
    // next to the contracted limit (vehicle_limit).
    const data = businessRows.map(({ _count, ...business }) => ({
      ...business,
      vehicle_count: _count.vehicles,
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
      const { count } = await transaction.business.updateMany({
        where: { id: businessId, is_active: expectedActive },
        data: { is_active: !expectedActive },
      });

      if (count === 0) return null;

      return transaction.business.findUnique({ where: { id: businessId } });
    };

    // The caller's transaction when it has one (the audit entry joins it).
    return tx ? toggle(tx) : this.prisma.$transaction(toggle);
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
    const deleteBusiness = await (tx ?? this.prisma).business.delete({
      where: {
        id: businessId,
      },
    });

    return deleteBusiness;
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
