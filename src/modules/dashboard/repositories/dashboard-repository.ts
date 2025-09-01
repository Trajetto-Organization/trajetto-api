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

    // Try UTC query first
    const startDateUTC = new Date(params.startDate + "T00:00:00.000Z");
    const endDateUTC = new Date(params.endDate + "T23:59:59.999Z");

    const whereClauseUTC: any = {
      created_at: {
        gte: startDateUTC,
        lte: endDateUTC,
      },
    };

    if (businessId) {
      whereClauseUTC.businessId = businessId;
    }

    const countUTC = await model.count({ where: whereClauseUTC });

    // If UTC query returns results, use it
    if (countUTC > 0) {
      return { count: countUTC };
    }

    // Fallback: try local timezone query
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Check if we're querying for today's date
    const queryDate = new Date(params.startDate);
    const today = new Date();

    const isToday =
      queryDate.getFullYear() === today.getFullYear() &&
      queryDate.getMonth() === today.getMonth() &&
      queryDate.getDate() === today.getDate();

    if (isToday) {
      const whereClauseLocal: any = {
        created_at: {
          gte: todayStart,
          lte: todayEnd,
        },
      };

      if (businessId) {
        whereClauseLocal.businessId = businessId;
      }

      const countLocal = await model.count({ where: whereClauseLocal });

      // Use local result if it's greater than UTC result
      if (countLocal > countUTC) {
        return { count: countLocal };
      }
    }

    return { count: countUTC };
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
    // Try UTC query first
    const startDateUTC = new Date(params.startDate + "T00:00:00.000Z");
    const endDateUTC = new Date(params.endDate + "T23:59:59.999Z");

    const whereClauseUTC: any = {
      created_at: {
        gte: startDateUTC,
        lte: endDateUTC,
      },
    };

    if (businessId) {
      whereClauseUTC.businessId = businessId;
    }

    const serviceOrdersUTC = await this.prisma.serviceOrder.findMany({
      where: whereClauseUTC,
      select: {
        id: true,
        maintenance_type: true,
        total_amount: true,
        created_at: true,
      },
    });

    let preventiveUTC = 0;
    let correctiveUTC = 0;

    serviceOrdersUTC.forEach((order) => {
      if (order.maintenance_type === "INTERNAL") {
        preventiveUTC += Number(order.total_amount);
      } else {
        correctiveUTC += Number(order.total_amount);
      }
    });

    // If UTC query returns results, use it
    if (serviceOrdersUTC.length > 0) {
      return {
        preventive: preventiveUTC,
        corrective: correctiveUTC,
      };
    }

    // Fallback: try local timezone query
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Check if we're querying for today's date
    const queryDate = new Date(params.startDate);
    const today = new Date();

    const isToday =
      queryDate.getFullYear() === today.getFullYear() &&
      queryDate.getMonth() === today.getMonth() &&
      queryDate.getDate() === today.getDate();

    if (isToday) {
      const whereClauseLocal: any = {
        created_at: {
          gte: todayStart,
          lte: todayEnd,
        },
      };

      if (businessId) {
        whereClauseLocal.businessId = businessId;
      }

      const serviceOrdersLocal = await this.prisma.serviceOrder.findMany({
        where: whereClauseLocal,
        select: {
          id: true,
          maintenance_type: true,
          total_amount: true,
          created_at: true,
        },
      });

      let preventiveLocal = 0;
      let correctiveLocal = 0;

      serviceOrdersLocal.forEach((order) => {
        if (order.maintenance_type === "INTERNAL") {
          preventiveLocal += Number(order.total_amount);
        } else {
          correctiveLocal += Number(order.total_amount);
        }
      });

      // Use local result if it has more orders than UTC result
      if (serviceOrdersLocal.length > serviceOrdersUTC.length) {
        return {
          preventive: preventiveLocal,
          corrective: correctiveLocal,
        };
      }
    }

    return {
      preventive: preventiveUTC,
      corrective: correctiveUTC,
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
