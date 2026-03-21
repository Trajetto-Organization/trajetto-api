import { IServiceOrderRepository } from "./IService-order-repository";
import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  SearchServiceOrderWithCursorProps,
  CursorPaginatedServiceOrder,
  SearchServiceOrderByVehicleWithCursorProps,
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

    const [serviceOrderData, total] = await Promise.all([
      this.prisma.serviceOrder.findMany({
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
      }),
      this.prisma.serviceOrder.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: serviceOrderData,
      total,
    };
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

  async searchServiceOrderWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchServiceOrderWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    const items = await this.prisma.serviceOrder.findMany({
      where: { businessId },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { created_at: "desc" },
      include: {
        vehicle: {
          select: {
            license_plate: true,
            description: true,
          },
        },
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async searchServiceOrderByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
  }: SearchServiceOrderByVehicleWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    const items = await this.prisma.serviceOrder.findMany({
      where: { vehicleId, businessId },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { created_at: "desc" },
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
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async *streamServiceOrdersForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
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
        ...(userRole === "MASTER"
          ? [
              {
                businessId: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ]
          : []),
        ...(numericSearch
          ? [{ total_amount: parseFloat(normalizedSearch) }]
          : []),
      );
    }

    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const serviceOrders: any = await this.prisma.serviceOrder.findMany({
        where: whereCondition,
        include: {
          business: { select: { corporate_reason: true } },
          vehicle: { select: { license_plate: true, description: true } },
          responsibleUser: { select: { name: true, email: true } },
          branch: { select: { corporate_reason: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (serviceOrders.length === 0) break;
      for (const so of serviceOrders) {
        yield {
          id: so.id,
          date: so.date,
          completion_date: so.completion_date,
          maintenance_type: so.maintenance_type,
          total_amount: so.total_amount?.toNumber(),
          current_mileage_at_service: so.current_mileage_at_service,
          maintenance_interval_km_at_service:
            so.maintenance_interval_km_at_service,
          last_maintenance_mileage_at_service:
            so.last_maintenance_mileage_at_service,
          new_mileage_after_service: so.new_mileage_after_service,
          businessId: so.businessId,
          ...(userRole === "MASTER"
            ? { businessName: so.business.corporate_reason }
            : {}),
          vehicleId: so.vehicleId,
          vehicleLicensePlate: so.vehicle.license_plate,
          vehicleDescription: so.vehicle.description,
          responsibleUserId: so.responsibleUserId,
          responsibleUserName: so.responsibleUser.name,
          responsibleUserEmail: so.responsibleUser.email,
          branchId: so.branchId,
          branchName: so.branch.corporate_reason,
          supplierId: so.supplierId,
          supplierName: so.supplier?.name || null,
          // 📍 GEOLOCATION: Proper null handling to avoid Number(null) = 0 issue
          latitude: so.latitude,
          longitude: so.longitude,
          latitude_original: so.latitude_original,
          longitude_original: so.longitude_original,
          location_source: so.location_source,
          location_edited_by: so.location_edited_by,
          location_edited_at: so.location_edited_at,
          created_from: so.created_from,
          created_at: so.created_at,
          updated_at: so.updated_at,
        };
      }

      cursor = serviceOrders[serviceOrders.length - 1].id;
    }
  }
}

export { ServiceOrderRepository };
