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
        {
          ...(currentUserRole === "MASTER"
            ? {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              }
            : {}),
        },
        {
          ...(currentUserRole === "MASTER"
            ? {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              }
            : {}),
        },
      );
    }

    // Adds filtering by businessId if the user is not MASTER
    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [branchData, total] = await Promise.all([
      // Include business data only if user is MASTER
      this.prisma.branch.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        ...(currentUserRole === "MASTER" && {
          include: {
            business: {
              select: {
                corporate_reason: true,
              },
            },
          },
        }),
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.branch.count({
        where: whereCondition,
      }),
    ]);

    return { data: branchData, total };
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

  async searchBranchWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchBranchWithCursorProps): Promise<CursorPaginatedBranch> {
    const items = await this.prisma.branch.findMany({
      where: { businessId, is_active: true },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: {
        created_at: "desc",
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countBranchDependencies(
    branchId: string,
  ): Promise<Record<string, number>> {
    const [
      vehicles,
      drivers,
      serviceOrders,
      accountsPayable,
      fines,
      fuels,
      vehicleChecklists,
    ] = await Promise.all([
      this.prisma.vehicle.count({ where: { branchId } }),
      this.prisma.driver.count({ where: { branchId } }),
      this.prisma.serviceOrder.count({ where: { branchId } }),
      this.prisma.accountPayable.count({ where: { branchId } }),
      this.prisma.fine.count({ where: { branchId } }),
      this.prisma.fuel.count({ where: { branchId } }),
      this.prisma.vehicleChecklist.count({ where: { branchId } }),
    ]);

    return {
      vehicles,
      drivers,
      serviceOrders,
      accountsPayable,
      fines,
      fuels,
      vehicleChecklists,
    };
  }
}

export { BranchRepository };
