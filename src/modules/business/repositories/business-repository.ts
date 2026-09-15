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

import database from "@/../infra/database";

import { buildSearchOr } from "@/shared/pagination/search-or";

class BusinessRepository implements IBusinessRepository {
  constructor(private prisma = database) {}

  async createBusiness(businessData: CreateBusinessProps): Promise<Business> {
    const businessCreated = await this.prisma.business.create({
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

    return businessCreated;
  }

  async listBusiness({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListBusinessByBusinessIdProps): Promise<ListBusinessProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const digitSearch = normalizedSearch.replace(/\D/g, "");

    let digitSearchPhone = digitSearch;

    if (digitSearchPhone.startsWith("55") && digitSearchPhone.length > 10) {
      digitSearchPhone = digitSearchPhone.substring(2);
    }

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        {
          corporate_reason: { contains: normalizedSearch, mode: "insensitive" },
        },
        { fantasy_name: { contains: normalizedSearch, mode: "insensitive" } },
        { city: { contains: normalizedSearch, mode: "insensitive" } },
        { uf: { contains: normalizedSearch, mode: "insensitive" } },
        { street: { contains: normalizedSearch, mode: "insensitive" } },
        { address_number: { contains: normalizedSearch, mode: "insensitive" } },
        { complement: { contains: normalizedSearch, mode: "insensitive" } },
        { cnae: { contains: normalizedSearch, mode: "insensitive" } },
        { erp_code: { contains: normalizedSearch, mode: "insensitive" } },
        {
          responsible_name: { contains: normalizedSearch, mode: "insensitive" },
        },
        { email: { contains: normalizedSearch, mode: "insensitive" } },
        ...(digitSearch
          ? [
              { cep: { contains: digitSearch, mode: "insensitive" } },
              {
                telephone: { contains: digitSearchPhone, mode: "insensitive" },
              },
              { cnpj: { contains: digitSearch, mode: "insensitive" } },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { id: businessId }),
      ...buildSearchOr(orConditions),
    };

    const [businessRows, total] = await Promise.all([
      this.prisma.business.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: {
          created_at: "desc", // Sort by created_at
        },
        include: {
          _count: {
            // Active fleet only — INACTIVE vehicles free their slot.
            select: {
              vehicles: { where: { status: { not: "INACTIVE" } } },
            },
          },
        },
      }),
      this.prisma.business.count({
        where: whereCondition,
      }),
    ]);

    // Flatten the relation count so the API exposes registered fleet size
    // next to the contracted limit (vehicle_limit).
    const businessData = businessRows.map(({ _count, ...business }) => ({
      ...business,
      vehicle_count: _count.vehicles,
    }));

    return { data: businessData, total };
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
      ...(search && {
        OR: [
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
        ],
      }),
    };

    const businesses = await this.prisma.business.findMany({
      where: whereCondition,
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: {
        created_at: "desc",
      },
    });

    const hasMore = businesses.length > limit;

    const data = hasMore ? businesses.slice(0, limit) : businesses;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async toggleBusinessActive(
    businessId: string,
    expectedActive: boolean,
  ): Promise<Business | null> {
    return this.prisma.$transaction(async (transaction) => {
      const { count } = await transaction.business.updateMany({
        where: { id: businessId, is_active: expectedActive },
        data: { is_active: !expectedActive },
      });

      if (count === 0) return null;

      return transaction.business.findUnique({ where: { id: businessId } });
    });
  }

  async updateBusiness({
    businessData,
    businessId,
  }: UpdateBusiness): Promise<Business> {
    const filteredData = Object.fromEntries(
      Object.entries(businessData).filter(([_, value]) => value !== undefined),
    );

    const updateBusiness = await this.prisma.business.update({
      where: {
        id: businessId,
      },
      data: filteredData,
    });

    return updateBusiness;
  }

  async deleteBusiness(businessId: string): Promise<Business> {
    const deleteBusiness = await this.prisma.business.delete({
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
        corporate_reason: {
          equals: corporateReason,
          mode: "insensitive",
        },
      },
    });

    return findBusinessByCorporateReason;
  }

  async findBusinessByErpcode(erpCode: string): Promise<Business | null> {
    const findBusinessByErpcode = await this.prisma.business.findFirst({
      where: {
        erp_code: {
          equals: erpCode,
          mode: "insensitive",
        },
      },
    });

    return findBusinessByErpcode;
  }

  async findBusinessByEmail(email: string): Promise<Business | null> {
    const findBusinessByEmail = await this.prisma.business.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
    });

    return findBusinessByEmail;
  }

  async updateVehicleLimit(
    businessId: string,
    vehicle_limit: number,
  ): Promise<Business> {
    // Lowering the limit below the current fleet never deletes vehicles —
    // it only blocks new registrations (checked at create-vehicle time).
    const updatedBusiness = await this.prisma.business.update({
      where: { id: businessId },
      data: { vehicle_limit },
    });

    return updatedBusiness;
  }

  async updateAILimit(
    businessId: string,
    ai_analysis_limit: number,
  ): Promise<Business> {
    // Consumption lives in the AIUsagePeriod ledger and is never rewritten:
    // lowering the limit below what was already spent simply leaves zero
    // remaining for the rest of the period.
    const updatedBusiness = await this.prisma.business.update({
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
