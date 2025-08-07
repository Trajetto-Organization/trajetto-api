import { IServiceOrderRepository } from "./IService-order-repository";
import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  ListServiceOrderBusinessProps,
} from "../dtos/service-order-dto";

import database from "@/../infra/database";
import { formatDate, formatCurrency } from "@/config/format-values";

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
        ...(numericSearch
          ? [{ total_amount: parseFloat(normalizedSearch) }]
          : []),
      );

      orConditions.push({
        vehicle: {
          OR: [
            {
              license_plate: {
                contains: normalizedSearch,
                mode: "insensitive",
              },
            },
            {
              description: { contains: normalizedSearch, mode: "insensitive" },
            },
          ],
        },
      });

      orConditions.push({
        responsibleUser: {
          name: { contains: normalizedSearch, mode: "insensitive" },
        },
      });

      orConditions.push({
        branch: {
          OR: [
            {
              corporate_reason: {
                contains: normalizedSearch,
                mode: "insensitive",
              },
            },
            {
              fantasy_name: { contains: normalizedSearch, mode: "insensitive" },
            },
          ],
        },
      });

      orConditions.push({
        supplier: {
          name: { contains: normalizedSearch, mode: "insensitive" },
        },
      });
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
        date: "desc",
      },
    });

    const total = await this.prisma.serviceOrder.count({
      where: whereCondition,
    });

    const transformedServiceOrderData = serviceOrderData.map(
      (serviceOrder) => ({
        id: serviceOrder.id ?? "N/A",
        date: serviceOrder.date ?? "N/A",
        completion_date: serviceOrder.completion_date ?? "N/A",
        maintenance_type: serviceOrder.maintenance_type ?? "N/A",
        total_amount:
          formatCurrency(Number(serviceOrder.total_amount)) ?? "N/A",
        current_mileage_at_service:
          serviceOrder.current_mileage_at_service ?? null,
        maintenance_interval_km_at_service:
          serviceOrder.maintenance_interval_km_at_service ?? null,
        last_maintenance_mileage_at_service:
          serviceOrder.last_maintenance_mileage_at_service ?? null,
        new_mileage_after_service:
          serviceOrder.new_mileage_after_service ?? null,
        businessId: serviceOrder.businessId ?? "N/A",
        vehicleId: serviceOrder.vehicleId ?? "N/A",
        vehicleLicensePlate: serviceOrder.vehicle?.license_plate ?? "N/A",
        vehicleDescription: serviceOrder.vehicle?.description ?? "N/A",
        responsibleUserId: serviceOrder.responsibleUserId ?? "N/A",
        responsibleUserName: serviceOrder.responsibleUser?.name ?? "N/A",
        responsibleUserEmail: serviceOrder.responsibleUser?.email ?? "N/A",
        branchId: serviceOrder.branchId ?? "N/A",
        branchName: serviceOrder.branch?.corporate_reason ?? "N/A",
        ...(currentUserRole === "MASTER"
          ? { business_name: serviceOrder.business.corporate_reason ?? "N/A" }
          : {}),
        supplierId: serviceOrder.supplierId ?? null,
        supplierName: serviceOrder.supplier?.name ?? "N/A",
        partsCount: serviceOrder.parts.length ?? 0,
        created_at: formatDate(serviceOrder.created_at, "pt-BR") ?? "N/A",
        updated_at: formatDate(serviceOrder.updated_at, "pt-BR") ?? "N/A",
      }),
    );

    return {
      data: transformedServiceOrderData,
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
      orderBy: { date: "desc" },
    });

    return serviceOrders;
  }
}

export { ServiceOrderRepository };
