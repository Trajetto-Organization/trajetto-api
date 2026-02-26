import { IServiceOrderRepository } from "./IService-order-repository";
import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  ListServiceOrderBusinessProps,
  ListServiceOrderByVehicleIdProps,
} from "../dtos/service-order-dto";

import database from "@/../infra/database";

class ServiceOrderRepository implements IServiceOrderRepository {
  constructor(private prisma = database) {}

  async createServiceOrder(
    serviceOrderData: CreateServiceOrderProps,
  ): Promise<ServiceOrder> {
    const serviceOrderCreated = await this.prisma.serviceOrder.create({
      data: {
        date: serviceOrderData.date || new Date(),
        completion_date: serviceOrderData.completion_date,
        maintenance_type: serviceOrderData.maintenance_type,
        total_amount: serviceOrderData.total_amount,
        current_mileage_at_service: serviceOrderData.current_mileage_at_service,
        maintenance_interval_km_at_service:
          serviceOrderData.maintenance_interval_km_at_service,
        last_maintenance_mileage_at_service:
          serviceOrderData.last_maintenance_mileage_at_service,
        new_mileage_after_service: serviceOrderData.new_mileage_after_service,
        latitude: serviceOrderData.latitude,
        longitude: serviceOrderData.longitude,
        business: {
          connect: {
            id: serviceOrderData.businessId,
          },
        },
        vehicle: {
          connect: {
            id: serviceOrderData.vehicleId,
          },
        },
        responsibleUser: {
          connect: {
            id: serviceOrderData.responsibleUserId,
          },
        },
        branch: {
          connect: {
            id: serviceOrderData.branchId,
          },
        },
        ...(serviceOrderData.supplierId && {
          supplier: {
            connect: {
              id: serviceOrderData.supplierId,
            },
          },
        }),
      },
    });

    return serviceOrderCreated;
  }

  async listServiceOrders({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListServiceOrderByBusinessIdProps): Promise<ListServiceOrderProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      const numericSearch = !isNaN(parseFloat(normalizedSearch));

      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { branchId: { contains: normalizedSearch, mode: "insensitive" } },
        { vehicleId: { contains: normalizedSearch, mode: "insensitive" } },
        {
          responsibleUserId: {
            contains: normalizedSearch,
            mode: "insensitive",
          },
        },
        {
          supplierId: {
            contains: normalizedSearch,
            mode: "insensitive",
          },
        },
        {
          vehicle: {
            OR: [
              {
                license_plate: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
        {
          responsibleUser: {
            name: { contains: normalizedSearch, mode: "insensitive" },
          },
        },
        {
          branch: {
            OR: [
              {
                corporate_reason: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                fantasy_name: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
        {
          supplier: {
            name: { contains: normalizedSearch, mode: "insensitive" },
          },
        },
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
        ...(numericSearch
          ? [{ total_amount: parseFloat(normalizedSearch) }]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const serviceOrderData = await this.prisma.serviceOrder.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
        vehicle: {
          select: {
            license_plate: true,
            description: true,
          },
        },
        responsibleUser: {
          select: {
            name: true,
            email: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        supplier: {
          select: {
            name: true,
          },
        },
        parts: {
          include: {
            part: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.serviceOrder.count({
      where: whereCondition,
    });

    return {
      data: serviceOrderData,
      total,
    };
  }

  async listServiceOrderBusiness({
    page,
    pageSize,
    businessId,
  }: ListServiceOrderBusinessProps): Promise<ListServiceOrderProps> {
    const skip = (page - 1) * pageSize;

    const serviceOrderBusinessData = await this.prisma.serviceOrder.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
      include: {
        vehicle: {
          select: {
            license_plate: true,
            description: true,
          },
        },
      },
    });

    const total = await this.prisma.serviceOrder.count({
      where: {
        businessId,
      },
    });

    return { data: serviceOrderBusinessData, total };
  }

  async updateServiceOrder({
    serviceOrderData,
    serviceOrderId,
  }: UpdateServiceOrder): Promise<ServiceOrder> {
    const filteredData = Object.fromEntries(
      Object.entries(serviceOrderData).filter(
        ([_, value]) => value !== undefined,
      ),
    );

    const updateServiceOrder = await this.prisma.serviceOrder.update({
      where: {
        id: serviceOrderId,
      },
      data: filteredData,
      include: {
        vehicle: true,
        responsibleUser: true,
        branch: true,
        supplier: true,
      },
    });

    return updateServiceOrder;
  }

  async deleteServiceOrder(serviceOrderId: string): Promise<ServiceOrder> {
    const deleteServiceOrder = await this.prisma.serviceOrder.delete({
      where: {
        id: serviceOrderId,
      },
    });

    return deleteServiceOrder;
  }

  async findServiceOrderById(
    serviceOrderId: string,
  ): Promise<ServiceOrder | null> {
    const findServiceOrderById = await this.prisma.serviceOrder.findUnique({
      where: {
        id: serviceOrderId,
      },
      include: {
        vehicle: true,
        responsibleUser: true,
        branch: true,
        supplier: true,
        parts: {
          include: {
            part: true,
          },
        },
      },
    });

    return findServiceOrderById;
  }

  async findServiceOrdersByVehicleId(
    vehicleId: string,
  ): Promise<ServiceOrder[] | null> {
    const findServiceOrdersByVehicleId =
      await this.prisma.serviceOrder.findMany({
        where: {
          vehicleId: vehicleId,
        },
      });

    return findServiceOrdersByVehicleId;
  }

  async findServiceOrdersByResponsibleUserId(
    responsibleUserId: string,
  ): Promise<ServiceOrder[]> {
    const serviceOrders = await this.prisma.serviceOrder.findMany({
      where: { responsibleUserId },
      include: {
        vehicle: { select: { license_plate: true, description: true } },
        business: { select: { corporate_reason: true } },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return serviceOrders;
  }

  async listServiceOrdersByVehicleId({
    vehicleId,
    businessId,
    page,
    pageSize,
  }: ListServiceOrderByVehicleIdProps): Promise<ListServiceOrderProps> {
    const skip = (page - 1) * pageSize;

    const whereCondition = {
      vehicleId,
      businessId,
    };

    const serviceOrderData = await this.prisma.serviceOrder.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        vehicle: {
          select: {
            id: true,
            license_plate: true,
            description: true,
            brand: true,
            model: true,
          },
        },
        responsibleUser: {
          select: {
            id: true,
            name: true,
          },
        },
        branch: {
          select: {
            id: true,
            corporate_reason: true,
          },
        },
        supplier: {
          select: {
            id: true,
            name: true,
          },
        },
        parts: {
          select: {
            id: true,
            quantity: true,
            unit_price: true,
            part: {
              select: {
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

    const total = await this.prisma.serviceOrder.count({
      where: whereCondition,
    });

    return {
      data: serviceOrderData,
      total,
    };
  }
}

export { ServiceOrderRepository };
