import { IFuelTypeRepository } from "./IFuel-type-repository";
import {
  FuelType,
  CreateFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  ListFuelTypeProps,
  UpdateFuelType,
  ListFuelTypeBusinessProps,
} from "../dtos/fuel-type-dto";

import database from "@/../infra/database";
import { formatDate } from "@/config/format-values";

class FuelTypeRepository implements IFuelTypeRepository {
  constructor(private prisma = database) {}

  async createFuelType(fuelTypeData: CreateFuelTypeProps): Promise<FuelType> {
    const fuelTypeCreated = await this.prisma.fuelType.create({
      data: {
        description: fuelTypeData.description,
        business: {
          connect: {
            id: fuelTypeData.businessId,
          },
        },
      },
    });

    return fuelTypeCreated;
  }

  async listFuelTypes({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListFuelTypeByBusinessIdProps): Promise<ListFuelTypeProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const fuelTypeData = await this.prisma.fuelType.findMany({
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

    const total = await this.prisma.fuelType.count({
      where: whereCondition,
    });

    const transformedFuelTypeData = fuelTypeData.map((fuelType) => ({
      id: fuelType.id ?? "N/A",
      description: fuelType.description ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { businessId: fuelType.businessId ?? "N/A" }
        : {}),
      ...(currentUserRole === "MASTER"
        ? { business_name: fuelType.business?.corporate_reason ?? "N/A" }
        : {}),
      created_at: formatDate(fuelType.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(fuelType.updated_at, "pt-BR") ?? "N/A",
    }));

    return {
      data: transformedFuelTypeData,
      total,
    };
  }

  async listFuelTypeBusiness({
    page,
    pageSize,
    businessId,
  }: ListFuelTypeBusinessProps): Promise<ListFuelTypeProps> {
    const skip = (page - 1) * pageSize;

    const fuelTypeBusinessData = await this.prisma.fuelType.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.fuelType.count({
      where: {
        businessId,
      },
    });

    return { data: fuelTypeBusinessData, total };
  }

  async updateFuelType({
    fuelTypeData,
    fuelTypeId,
  }: UpdateFuelType): Promise<FuelType> {
    const filteredData = Object.fromEntries(
      Object.entries(fuelTypeData).filter(
        ([_, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updateFuelType = await this.prisma.fuelType.update({
      where: {
        id: fuelTypeId,
      },
      data: filteredData,
    });

    return updateFuelType;
  }

  async deleteFuelType(fuelTypeId: string): Promise<FuelType> {
    const deleteFuelType = await this.prisma.fuelType.delete({
      where: {
        id: fuelTypeId,
      },
    });

    return deleteFuelType;
  }

  async findFuelTypeById(fuelTypeId: string): Promise<FuelType | null> {
    const findFuelTypeById = await this.prisma.fuelType.findUnique({
      where: {
        id: fuelTypeId,
      },
    });

    return findFuelTypeById;
  }

  async findFuelTypeByIdAndBusiness(
    fuelTypeId: string,
    businessId: string,
  ): Promise<FuelType | null> {
    const findFuelTypeById = await this.prisma.fuelType.findUnique({
      where: {
        id: fuelTypeId,
        businessId,
      },
    });

    return findFuelTypeById;
  }

  async findFuelTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<FuelType | null> {
    const findFuelTypeByDescription = await this.prisma.fuelType.findFirst({
      where: {
        description: {
          equals: description,
          mode: "insensitive",
        },
        businessId: businessId,
      },
    });

    return findFuelTypeByDescription;
  }
}

export { FuelTypeRepository };
