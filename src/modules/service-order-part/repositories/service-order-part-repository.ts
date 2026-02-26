import { IServiceOrderPartRepository } from "./IService-order-part-repository";
import {
  ServiceOrderPart,
  CreateServiceOrderPartProps,
  ListServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
  UpdateServiceOrderPart,
} from "../dtos/service-order-part-dto";

import database from "@/../infra/database";

class ServiceOrderPartRepository implements IServiceOrderPartRepository {
  constructor(private prisma = database) {}

  async createServiceOrderPart(
    serviceOrderPartData: CreateServiceOrderPartProps,
  ): Promise<ServiceOrderPart> {
    const serviceOrderPartCreated = await this.prisma.serviceOrderPart.create({
      data: {
        unit_price: serviceOrderPartData.unit_price,
        quantity: serviceOrderPartData.quantity,
        discount_percentage: serviceOrderPartData.discount_percentage,
        business: {
          connect: {
            id: serviceOrderPartData.businessId,
          },
        },
        serviceOrder: {
          connect: {
            id: serviceOrderPartData.serviceOrderId,
          },
        },
        part: {
          connect: {
            id: serviceOrderPartData.partId,
          },
        },
      },
      include: {
        part: true,
      },
    });

    return serviceOrderPartCreated;
  }

  async listServiceOrderParts({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListServiceOrderPartByBusinessIdProps): Promise<ListServiceOrderPartProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      const numericSearch = !isNaN(parseFloat(normalizedSearch));

      orConditions.push(
        // Service order part ID
        { id: { contains: normalizedSearch, mode: "insensitive" } },

        // Part ID
        { partId: { contains: normalizedSearch, mode: "insensitive" } },

        // Part description
        {
          part: {
            description: { contains: normalizedSearch, mode: "insensitive" },
          },
        },

        // Service order ID
        { serviceOrderId: { contains: normalizedSearch, mode: "insensitive" } },

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

        // Numeric fields
        ...(numericSearch
          ? [
              { unit_price: parseFloat(normalizedSearch) },
              { quantity: parseInt(normalizedSearch) },
              { discount_percentage: parseFloat(normalizedSearch) },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const serviceOrderPartData = await this.prisma.serviceOrderPart.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        part: true,
        business: {
          select: {
            corporate_reason: true,
          },
        },
        serviceOrder: {
          select: {
            id: true,
            date: true,
            vehicle: {
              select: {
                license_plate: true,
                description: true,
              },
            },
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.serviceOrderPart.count({
      where: whereCondition,
    });

    return {
      data: serviceOrderPartData,
      total,
    };
  }

  async updateServiceOrderPart({
    serviceOrderPartData,
    serviceOrderPartId,
  }: UpdateServiceOrderPart): Promise<ServiceOrderPart> {
    const filteredData = Object.fromEntries(
      Object.entries(serviceOrderPartData).filter(
        ([_, value]) => value !== undefined,
      ),
    );

    const updateServiceOrderPart = await this.prisma.serviceOrderPart.update({
      where: {
        id: serviceOrderPartId,
      },
      data: filteredData,
      include: {
        part: true,
      },
    });

    return updateServiceOrderPart;
  }

  async deleteServiceOrderPart(
    serviceOrderPartId: string,
  ): Promise<ServiceOrderPart> {
    const deleteServiceOrderPart = await this.prisma.serviceOrderPart.delete({
      where: {
        id: serviceOrderPartId,
      },
    });

    return deleteServiceOrderPart;
  }

  async findServiceOrderPartById(
    serviceOrderPartId: string,
  ): Promise<ServiceOrderPart | null> {
    const findServiceOrderPartById =
      await this.prisma.serviceOrderPart.findUnique({
        where: {
          id: serviceOrderPartId,
        },
        include: {
          part: true,
          serviceOrder: true,
        },
      });

    return findServiceOrderPartById;
  }

  async findServiceOrderPartByPartId(
    partId: string,
    serviceOrderId: string,
  ): Promise<ServiceOrderPart | null> {
    const findServiceOrderPartByPartId =
      await this.prisma.serviceOrderPart.findFirst({
        where: {
          partId: partId,
          serviceOrderId: serviceOrderId,
        },
      });

    return findServiceOrderPartByPartId;
  }

  async calculateServiceOrderTotal(serviceOrderId: string): Promise<number> {
    // Search for all parts of the work order
    const serviceOrderParts = await this.prisma.serviceOrderPart.findMany({
      where: {
        serviceOrderId: serviceOrderId,
      },
    });

    // Calculate the total
    let total = 0;

    for (const part of serviceOrderParts) {
      const partTotal = Number(part.unit_price) * part.quantity;
      const discount = partTotal * (Number(part.discount_percentage) / 100);

      total += partTotal - discount;
    }

    return total;
  }
}

export { ServiceOrderPartRepository };
