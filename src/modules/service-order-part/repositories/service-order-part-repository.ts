import { IServiceOrderPartRepository } from "./IService-order-part-repository";
import {
  ServiceOrderPart,
  CreateServiceOrderPartProps,
  ListServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
  UpdateServiceOrderPart,
} from "../dtos/service-order-part-dto";

import database from "@/../infra/database";
import { formatDate, formatCurrency } from "@/config/format-values";

class ServiceOrderPartRepository implements IServiceOrderPartRepository {
  constructor(private prisma = database) {}

  async createServiceOrderPart(
    serviceOrderPartData: CreateServiceOrderPartProps,
  ): Promise<ServiceOrderPart> {
    const serviceOrderPartCreated = await this.prisma.serviceOrderPart.create({
      data: {
        unit_price: serviceOrderPartData.unit_price,
        quantity: serviceOrderPartData.quantity,
        discount_percentage: serviceOrderPartData.discount_percentage || 0,
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
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        ...(numericSearch
          ? [
              { unit_price: parseFloat(normalizedSearch) },
              { quantity: parseInt(normalizedSearch) },
              { discount_percentage: parseFloat(normalizedSearch) },
            ]
          : []),
      );

      orConditions.push({
        part: {
          description: { contains: normalizedSearch, mode: "insensitive" },
        },
      });

      orConditions.push({
        serviceOrder: {
          id: { contains: normalizedSearch, mode: "insensitive" },
        },
      });
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
        created_at: "desc",
      },
    });

    const total = await this.prisma.serviceOrderPart.count({
      where: whereCondition,
    });

    const transformedServiceOrderPartData = serviceOrderPartData.map(
      (serviceOrderPart) => {
        // Calculate total and discounted price
        const totalPrice =
          Number(serviceOrderPart.unit_price) * serviceOrderPart.quantity;
        const discountAmount =
          totalPrice * (Number(serviceOrderPart.discount_percentage) / 100);

        const totalWithDiscount = totalPrice - discountAmount;

        return {
          id: serviceOrderPart.id ?? "N/A",
          unit_price:
            formatCurrency(Number(serviceOrderPart.unit_price)) ?? "N/A",
          quantity: serviceOrderPart.quantity ?? 0,
          discount_percentage: serviceOrderPart.discount_percentage
            ? `${Number(serviceOrderPart.discount_percentage)}%`
            : "0%",
          businessId: serviceOrderPart.businessId ?? "N/A",
          ...(currentUserRole === "MASTER"
            ? {
                business_name:
                  serviceOrderPart.business.corporate_reason ?? "N/A",
              }
            : {}),
          serviceOrderId: serviceOrderPart.serviceOrderId ?? "N/A",
          vehicleLicensePlate:
            serviceOrderPart.serviceOrder.vehicle.license_plate ?? "N/A",
          vehicleDescription:
            serviceOrderPart.serviceOrder.vehicle.description ?? "N/A",
          serviceOrderDate: serviceOrderPart.serviceOrder.date ?? "N/A",
          partId: serviceOrderPart.partId ?? "N/A",
          partDescription: serviceOrderPart.part?.description ?? "N/A",
          partUnitPrice:
            formatCurrency(Number(serviceOrderPart.part?.unit_price)) ?? "N/A",
          totalPrice: formatCurrency(totalPrice) ?? "N/A",
          totalWithDiscount: formatCurrency(totalWithDiscount) ?? "N/A",
          created_at: formatDate(serviceOrderPart.created_at, "pt-BR") ?? "N/A",
          updated_at: formatDate(serviceOrderPart.updated_at, "pt-BR") ?? "N/A",
        };
      },
    );

    return {
      data: transformedServiceOrderPartData,
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
