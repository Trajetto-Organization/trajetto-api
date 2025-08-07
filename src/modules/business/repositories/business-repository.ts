import { IBusinessRepository } from "./IBusiness-repository";
import {
  Business,
  CreateBusinessProps,
  ListBusinessByBusinessIdProps,
  ListBusinessProps,
  UpdateBusiness,
} from "../dtos/business-dto";

import database from "@/../infra/database";
import {
  formatCep,
  formatCnpj,
  formatDate,
  formatTelephone,
} from "@/config/format-values";

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

    const businessData = await this.prisma.business.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
    });

    const total = await this.prisma.business.count({
      where: whereCondition,
    });

    const transformedBusinessData = businessData.map((business) => ({
      id: business.id ?? "N/A",
      corporate_reason: business.corporate_reason ?? "N/A",
      fantasy_name: business.fantasy_name ? business.fantasy_name : "N/A",
      cep: business.cep ? formatCep(business.cep) : "N/A",
      city: business.city ?? "N/A",
      uf: business.uf ?? "N/A",
      street: business.street ?? "N/A",
      address_number: business.address_number ?? "N/A",
      complement: business.complement ? business.complement : "N/A",
      cnae: business.cnae ?? "N/A",
      erp_code: business.erp_code ? business.erp_code : "N/A",
      responsible_name: business.responsible_name ?? "N/A",
      email: business.email ?? "N/A",
      created_at: formatDate(business.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(business.updated_at, "pt-BR") ?? "N/A",
      telephone: business.telephone
        ? formatTelephone(business.telephone)
        : "N/A",
      cnpj: business.cnpj ? formatCnpj(business.cnpj) : "N/A",
    }));

    return { data: transformedBusinessData, total };
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
}

export { BusinessRepository };
