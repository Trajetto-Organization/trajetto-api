import { IBranchRepository } from "./IBranch-repository";
import {
  Branch,
  CreateBranchProps,
  ListAllBranchesProps,
  ListBranchBusinessProps,
  ListBranchProps,
  UpdateBranch,
} from "../dtos/branch-dto";

import database from "@/../infra/database";
import {
  formatCep,
  formatCnpj,
  formatDate,
  formatTelephone,
} from "@/config/format-values";

class BranchRepository implements IBranchRepository {
  constructor(private prisma = database) {}

  async createBranch(branchData: CreateBranchProps): Promise<Branch> {
    const branchCreated = await this.prisma.branch.create({
      data: {
        ...branchData,
        erp_code: branchData.erp_code || null,
        complement: branchData.complement || null,
      },
    });

    return branchCreated;
  }

  async listAllBranches({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
  }: ListAllBranchesProps): Promise<ListBranchProps> {
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
        { street: { contains: normalizedSearch, mode: "insensitive" } },
        { address_number: { contains: normalizedSearch, mode: "insensitive" } },
        { city: { contains: normalizedSearch, mode: "insensitive" } },
        { uf: { contains: normalizedSearch, mode: "insensitive" } },
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

    // Adds filtering by businessId if the user is not MASTER
    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const branchData = await this.prisma.branch.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      orderBy: {
        created_at: "desc",
      },
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
      },
    });

    const total = await this.prisma.branch.count({
      where: whereCondition,
    });

    const transformedBranchData = branchData.map((branch) => ({
      id: branch.id ?? "N/A",
      corporate_reason: branch.corporate_reason ?? "N/A",
      fantasy_name: branch.fantasy_name ? branch.fantasy_name : "N/A",
      cep: branch.cep ? formatCep(branch.cep) : "N/A",
      city: branch.city ?? "N/A",
      uf: branch.uf ?? "N/A",
      street: branch.street ?? "N/A",
      address_number: branch.address_number ?? "N/A",
      cnpj: branch.cnpj ? formatCnpj(branch.cnpj) : "N/A",
      complement: branch.complement ? branch.complement : "N/A",
      cnae: branch.cnae ?? "N/A",
      erp_code: branch.erp_code ? branch.erp_code : "N/A",
      responsible_name: branch.responsible_name ?? "N/A",
      telephone: branch.telephone ? formatTelephone(branch.telephone) : "N/A",
      email: branch.email ?? "N/A",
      businessId: branch.businessId ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { business_name: branch.business?.corporate_reason ?? "N/A" }
        : {}),
      created_at: formatDate(branch.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(branch.updated_at, "pt-BR") ?? "N/A",
    }));

    return { data: transformedBranchData, total };
  }

  async listBranchBusiness({
    page,
    pageSize,
    businessId,
  }: ListBranchBusinessProps): Promise<ListBranchProps> {
    const skip = (page - 1) * pageSize;

    const branchBusinessData = await this.prisma.branch.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.branch.count({
      where: {
        businessId,
      },
    });

    return { data: branchBusinessData, total };
  }

  async updateBranch({ branchData, branchId }: UpdateBranch): Promise<Branch> {
    const filteredData = Object.fromEntries(
      Object.entries(branchData).filter(([_, value]) => value !== undefined),
    );

    const updatedBranch = await this.prisma.branch.update({
      where: {
        id: branchId,
      },
      data: {
        ...filteredData,
        erp_code: filteredData.erp_code || null,
        complement: filteredData.complement || null,
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

  async findBranchByErpCode(erp_code: string): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        erp_code,
      },
    });

    return branch;
  }

  async findBranchByEmail(email: string): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        email,
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
    corporate_reason: string,
  ): Promise<Branch | null> {
    const branch = await this.prisma.branch.findFirst({
      where: {
        corporate_reason: {
          equals: corporate_reason,
          mode: "insensitive",
        },
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
}

export { BranchRepository };
