import database from "@/../infra/database";
import { IVehicleTypeRepository } from "./IVehicle-type-repository";

import {
  VehicleType,
  CreateVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  ListVehicleTypeProps,
  UpdateVehicleType,
  ListVehicleTypeBusinessProps,
} from "../dtos/vehicle-type-dto";

class VehicleTypeRepository implements IVehicleTypeRepository {
  constructor(private prisma = database) {}

  async createVehicleType(
    vehicleTypeData: CreateVehicleTypeProps,
  ): Promise<VehicleType> {
    const vehicleTypeCreated = await this.prisma.vehicleType.create({
      data: vehicleTypeData,
    });

    return vehicleTypeCreated;
  }

  async listVehicleTypes({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListVehicleTypeByBusinessIdProps): Promise<ListVehicleTypeProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
        // Business ID and name (MASTER only)
        ...(currentUserRole === "MASTER"
          ? [
              {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              },
            ]
          : []),
        ...(normalizedSearch.match(/^\d+$/)
          ? [{ number_of_axles: parseInt(normalizedSearch, 10) }]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const vehicleTypeData = await this.prisma.vehicleType.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const total = await this.prisma.vehicleType.count({
      where: whereCondition,
    });

    return {
      data: vehicleTypeData,
      total,
    };
  }

  async listVehicleTypeBusiness({
    page,
    pageSize,
    businessId,
  }: ListVehicleTypeBusinessProps): Promise<ListVehicleTypeProps> {
    const skip = (page - 1) * pageSize;

    const vehicleTypeBusinessData = await this.prisma.vehicleType.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.vehicleType.count({
      where: {
        businessId,
      },
    });

    return { data: vehicleTypeBusinessData, total };
  }

  async updateVehicleType({
    vehicleTypeData,
    vehicleTypeId,
  }: UpdateVehicleType): Promise<VehicleType> {
    const filteredData = Object.fromEntries(
      Object.entries(vehicleTypeData).filter(
        ([_, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updateVehicleType = await this.prisma.vehicleType.update({
      where: {
        id: vehicleTypeId,
      },
      data: filteredData,
    });

    return updateVehicleType;
  }

  async deleteVehicleType(vehicleTypeId: string): Promise<VehicleType> {
    const deleteVehicleType = await this.prisma.vehicleType.delete({
      where: {
        id: vehicleTypeId,
      },
    });

    return deleteVehicleType;
  }

  async findVehicleTypeById(
    vehicleTypeId: string,
  ): Promise<VehicleType | null> {
    const findVehicleTypeById = await this.prisma.vehicleType.findUnique({
      where: {
        id: vehicleTypeId,
      },
    });

    return findVehicleTypeById;
  }

  async findVehicleTypeByIdAndBusiness(
    vehicleTypeId: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    const findVehicleTypeById = await this.prisma.vehicleType.findUnique({
      where: {
        id: vehicleTypeId,
        businessId,
      },
    });

    return findVehicleTypeById;
  }

  async findVehicleTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    const findVehicleTypeByDescription =
      await this.prisma.vehicleType.findFirst({
        where: {
          description: {
            equals: description,
            mode: "insensitive",
          },
          businessId: businessId,
        },
      });

    return findVehicleTypeByDescription;
  }
}

export { VehicleTypeRepository };
