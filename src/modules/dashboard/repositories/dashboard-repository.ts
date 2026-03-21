import database from "@/../infra/database";
import {
  CountByDateRangeParams,
  CountByDateRangeResult,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountResult,
  ModelWithCount,
} from "../dtos/dashboard-dto";

import { IDashboardRepository } from "./IDashboard-repository";

class DashboardRepository implements IDashboardRepository {
  constructor(private prisma = database) {}

  async countByDateRange(
    params: CountByDateRangeParams,
    businessId?: string,
  ): Promise<CountByDateRangeResult> {
    // Determines which model to use based on the entity parameter
    let model: ModelWithCount;
    switch (params.entity) {
      case "vehicle":
        model = this.prisma.vehicle;
        break;
      case "driver":
        model = this.prisma.driver;
        break;
      case "business":
        model = this.prisma.business;
        break;
      case "branch":
        model = this.prisma.branch;
        break;
      case "part":
        model = this.prisma.part;
        break;
      case "supplier":
        model = this.prisma.supplier;
        break;
      case "service-order":
        model = this.prisma.serviceOrder;
        break;
      case "user":
        model = this.prisma.user;
        break;
      case "fine":
        model = this.prisma.fine;
        break;
      default:
        throw new Error("Entidade inválida");
    }

    // Convert date string to local timezone Date objects
    // params.startDate and params.endDate are in format "YYYY-MM-DD"
    const [startYear, startMonth, startDay] = params.startDate
      .split("-")
      .map(Number);
    const [endYear, endMonth, endDay] = params.endDate.split("-").map(Number);

    // Create dates in local timezone (server timezone - Brazil UTC-3)
    const startDateLocal = new Date(
      startYear,
      startMonth - 1,
      startDay,
      0,
      0,
      0,
      0,
    );
    const endDateLocal = new Date(
      endYear,
      endMonth - 1,
      endDay,
      23,
      59,
      59,
      999,
    );

    const whereClause: any = {
      created_at: {
        gte: startDateLocal,
        lte: endDateLocal,
      },
    };

    if (businessId) {
      whereClause.businessId = businessId;
    }

    if (params.entity === "user") {
      whereClause.role = { not: "MASTER" };
    }

    const count = await model.count({ where: whereClause });
    return { count };
  }

  async countVehiclesByStatus(
    businessId?: string,
  ): Promise<VehicleStatusCountResult> {
    const whereClause: any = {};

    if (businessId) {
      whereClause.businessId = businessId;
    }

    const [active, inactive, blocked, inRoute] = await Promise.all([
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "ACTIVE",
        },
      }),
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "INACTIVE",
        },
      }),
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "BLOCKED",
        },
      }),
      this.prisma.vehicle.count({
        where: {
          ...whereClause,
          status: "IN_ROUTE",
        },
      }),
    ]);

    return {
      ACTIVE: active,
      INACTIVE: inactive,
      BLOCKED: blocked,
      IN_ROUTE: inRoute,
    };
  }

  async getMaintenanceStats(
    businessId?: string,
  ): Promise<MaintenanceStatsResult> {
    const whereClause: any = {};

    if (businessId) {
      whereClause.businessId = businessId;
    }

    const vehicles = await this.prisma.vehicle.findMany({
      where: whereClause,
      select: {
        id: true,
        last_maintenance_date: true,
        maintenance_interval_months: true,
        current_mileage: true,
        last_maintenance_mileage: true,
        maintenance_interval_km: true,
      },
    });

    const now = new Date();

    let pending = 0;
    let recent = 0;

    let overdue = 0;
    vehicles.forEach((vehicle) => {
      if (!vehicle.last_maintenance_date) {
        pending++;
        return;
      }

      const lastMaintenanceDate = new Date(vehicle.last_maintenance_date);

      // Calculate next maintenance date (by time)
      const nextMaintenanceDate = new Date(lastMaintenanceDate);
      nextMaintenanceDate.setMonth(
        nextMaintenanceDate.getMonth() + vehicle.maintenance_interval_months,
      );

      // Calculate next maintenance by mileage
      const nextMaintenanceKm =
        (vehicle.last_maintenance_mileage as number) +
        vehicle.maintenance_interval_km;
      const kmOverdue = vehicle.current_mileage >= nextMaintenanceKm;

      // Calculate days until next maintenance
      const daysUntilMaintenance = Math.floor(
        (nextMaintenanceDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (daysUntilMaintenance < 0 || kmOverdue) {
        overdue++;
      } else if (daysUntilMaintenance <= 30) {
        pending++;
      } else {
        recent++;
      }
    });

    return {
      pending,
      recent,
      overdue,
    };
  }

  async getMonthlyCosts(
    params: MonthlyCostsParams,
    businessId?: string,
  ): Promise<MonthlyCostsResult> {
    // Convert date string to local timezone Date objects
    // params.startDate and params.endDate are in format "YYYY-MM-DD"
    const [startYear, startMonth, startDay] = params.startDate
      .split("-")
      .map(Number);
    const [endYear, endMonth, endDay] = params.endDate.split("-").map(Number);

    // Create dates in local timezone (server timezone - Brazil UTC-3)
    const startDateLocal = new Date(
      startYear,
      startMonth - 1,
      startDay,
      0,
      0,
      0,
      0,
    );
    const endDateLocal = new Date(
      endYear,
      endMonth - 1,
      endDay,
      23,
      59,
      59,
      999,
    );

    const whereClause: any = {
      created_at: {
        gte: startDateLocal,
        lte: endDateLocal,
      },
    };

    if (businessId) {
      whereClause.businessId = businessId;
    }

    const serviceOrders = await this.prisma.serviceOrder.findMany({
      where: whereClause,
      select: {
        id: true,
        maintenance_type: true,
        total_amount: true,
        created_at: true,
      },
    });

    let preventive = 0;
    let corrective = 0;

    serviceOrders.forEach((order) => {
      if (order.maintenance_type === "INTERNAL") {
        preventive += Number(order.total_amount);
      } else {
        corrective += Number(order.total_amount);
      }
    });

    return {
      preventive,
      corrective,
    };
  }

  async countVehiclesByType(
    businessId?: string,
  ): Promise<VehicleTypeCountResult> {
    const whereClause: any = {};

    if (businessId) {
      whereClause.businessId = businessId;
    }

    const vehicles = await this.prisma.vehicle.findMany({
      where: whereClause,
      select: {
        vehicleTypeId: true,
        vehicleType: {
          select: {
            description: true,
          },
        },
      },
    });

    const typeCounts: Record<string, number> = {};
    vehicles.forEach((vehicle) => {
      const typeDescription = vehicle.vehicleType?.description || "Outros";
      typeCounts[typeDescription] = (typeCounts[typeDescription] || 0) + 1;
    });

    const data = Object.entries(typeCounts).map(([name, count]) => ({
      name,
      count,
    }));

    return { data };
  }
}

export { DashboardRepository };
