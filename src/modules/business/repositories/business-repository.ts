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

class BusinessRepository implements IBusinessRepository {
  constructor(private prisma = database) {}

  async createBusiness(businessData: CreateBusinessProps): Promise<Business> {
    const businessCreated = await this.prisma.business.create({
      data: {
        ...businessData,
        erp_code: businessData.erp_code || null,
        complement: businessData.complement || null,
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
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [businessData, total] = await Promise.all([
      this.prisma.business.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: {
          created_at: "desc", // Sort by created_at
        },
      }),
      this.prisma.business.count({
        where: whereCondition,
      }),
    ]);

    return { data: businessData, total };
  }

  async searchBusinessWithCursor({
    limit = 10,
    cursor,
    businessId,
    currentUserRole,
  }: SearchBusinessWithCursorProps): Promise<CursorPaginatedBusiness> {
    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { id: businessId }),
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

  async updateAILimit(
    businessId: string,
    ai_analysis_limit: number,
  ): Promise<Business> {
    const current = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { ai_analysis_used: true },
    });

    const currentUsed = current?.ai_analysis_used ?? 0;
    const updatedBusiness = await this.prisma.business.update({
      where: { id: businessId },
      data: {
        ai_analysis_limit,
        ...(currentUsed > ai_analysis_limit && {
          ai_analysis_used: ai_analysis_limit,
        }),
      },
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
        ai_analysis_used: true,
        ai_analysis_reset_at: true,
      },
    });

    return business;
  }
}

export { BusinessRepository };
