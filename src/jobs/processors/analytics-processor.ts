import { FleetCommandJobData } from "../fleet-command-queue";

import { FleetAnalyticsRepository } from "@/modules/fleet-analytics/repositories/fleet-analytics-repository";
import { RouteRepository } from "@/modules/routing/repositories/route-repository";

import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";

import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";
import { sendNotificationToUser } from "@/websocket";

import {
  RouteEfficiencyResults,
  CostAnalysisResults,
  VehicleUtilizationResults,
  FuelConsumptionResults,
  MaintenanceCostResults,
} from "@/modules/fleet-analytics/dtos/fleet-analytics-dto";

class AnalyticsProcessor {
  private analyticsRepo: FleetAnalyticsRepository;

  private routeRepo: RouteRepository;
  private vehicleRepo: VehicleRepository;

  private fuelRepo: FuelRepository;
  private serviceOrderRepo: ServiceOrderRepository;

  constructor() {
    this.analyticsRepo = new FleetAnalyticsRepository();
    this.routeRepo = new RouteRepository();

    this.vehicleRepo = new VehicleRepository();
    this.fuelRepo = new FuelRepository();

    this.serviceOrderRepo = new ServiceOrderRepository();
  }

  async process(jobData: FleetCommandJobData): Promise<void> {
    const { businessId, userId, data } = jobData;
    const { analyticsType, period, startDate, endDate, metadata } = data;

    try {
      console.log(
        `[AnalyticsProcessor] Processing ${analyticsType} analytics for business ${businessId}`,
      );

      // Send WebSocket notification: processing started
      if (userId) {
        sendNotificationToUser(userId, {
          type: "analytics_processing",
          businessId,
          data: {
            analyticsType,
            period,
            status: "processing",
          },
        });
      }

      let results: any;

      switch (analyticsType) {
        case "route_efficiency":
          results = await this.processRouteEfficiency(
            businessId,
            startDate,
            endDate,
          );

          break;
        case "cost_analysis":
          results = await this.processCostAnalysis(
            businessId,
            startDate,
            endDate,
          );

          break;
        case "vehicle_utilization":
          results = await this.processVehicleUtilization(
            businessId,
            startDate,
            endDate,
          );

          break;
        case "fuel_consumption":
          results = await this.processFuelConsumption(
            businessId,
            startDate,
            endDate,
          );

          break;
        case "maintenance_cost":
          results = await this.processMaintenanceCost(
            businessId,
            startDate,
            endDate,
          );

          break;
        default:
          throw new Error(`Unknown analytics type: ${analyticsType}`);
      }

      // Save analytics result
      const analytics = await this.analyticsRepo.create({
        analyticsType,
        period,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        results,
        metadata,
        businessId,
      });

      console.log(
        `[AnalyticsProcessor] Analytics ${analytics.id} for business ${businessId} completed successfully`,
      );

      // Send WebSocket notification: analytics completed
      if (userId) {
        sendNotificationToUser(userId, {
          type: "analytics_completed",
          businessId,
          data: {
            analyticsId: analytics.id,
            analyticsType,
            period,
            status: "completed",
          },
        });
      }
    } catch (error) {
      console.error(
        `[AnalyticsProcessor] Error processing ${analyticsType} analytics for business ${businessId}:`,
        error,
      );

      // Send WebSocket notification: analytics failed
      if (userId) {
        sendNotificationToUser(userId, {
          type: "analytics_failed",
          businessId,
          data: {
            analyticsType,
            period,
            status: "failed",
            error: error instanceof Error ? error.message : "Erro desconhecido",
          },
        });
      }

      throw error;
    }
  }

  /**
   * ROUTE EFFICIENCY ANALYTICS
   * Calculates route performance metrics using RouteRepository
   */
  private async processRouteEfficiency(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<RouteEfficiencyResults> {
    const routes = await this.routeRepo.findRoutesByDateRange(
      businessId,
      startDate,
      endDate,
    );

    const totalRoutes = routes.length;

    const totalDistance = routes.reduce((sum, r) => sum + r.distance, 0);
    const totalDuration = routes.reduce((sum, r) => sum + r.duration, 0);

    const avgDistancePerRoute =
      totalRoutes > 0 ? totalDistance / totalRoutes : 0;
    const avgDurationPerRoute =
      totalRoutes > 0 ? totalDuration / totalRoutes : 0;

    // Average speed in km/h (duration is in seconds, distance in meters)
    const avgSpeed =
      totalDuration > 0 ? totalDistance / 1000 / (totalDuration / 3600) : 0;

    // Efficiency score: higher distance per unit time = better
    const efficiencyScore =
      totalDuration > 0 ? (totalDistance / totalDuration) * 100 : 0;

    // Sort routes by efficiency (distance/duration ratio)
    const sortedByEfficiency = routes
      .map((r) => ({
        routeId: r.id,
        routeName: r.name || undefined,
        distance: r.distance,
        duration: r.duration,
        efficiency: r.duration > 0 ? r.distance / r.duration : 0,
      }))
      .sort((a, b) => b.efficiency - a.efficiency);

    const topPerformingRoutes = sortedByEfficiency.slice(0, 5);
    const lowPerformingRoutes = sortedByEfficiency.slice(-5).reverse();

    return {
      totalRoutes,
      totalDistance,
      totalDuration,
      avgSpeed,
      avgDistancePerRoute,
      avgDurationPerRoute,
      efficiencyScore,
      topPerformingRoutes,
      lowPerformingRoutes,
    };
  }

  /**
   * COST ANALYSIS ANALYTICS
   * Calculates total costs using FuelRepository and ServiceOrderRepository
   */
  private async processCostAnalysis(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<CostAnalysisResults> {
    // Execute all independent queries in parallel for better performance
    const [fuelCost, maintenanceCost, totalDistance, routes] =
      await Promise.all([
        this.fuelRepo.getTotalCostByDateRange(businessId, startDate, endDate),
        this.serviceOrderRepo.getTotalCostByDateRange(
          businessId,
          startDate,
          endDate,
        ),
        this.routeRepo.getTotalDistanceByDateRange(
          businessId,
          startDate,
          endDate,
        ),
        this.routeRepo.findRoutesByDateRange(businessId, startDate, endDate),
      ]);

    const totalCost = fuelCost + maintenanceCost;
    const costPerKm =
      totalDistance > 0 ? totalCost / (totalDistance / 1000) : 0;
    const costPerRoute = routes.length > 0 ? totalCost / routes.length : 0;

    // Get top expensive vehicles by combining fuel and maintenance costs
    // Execute both queries in parallel
    const [fuelDataByVehicle, maintenanceDataByVehicle] = await Promise.all([
      this.fuelRepo.getFuelDataByVehicle(businessId, startDate, endDate),
      this.serviceOrderRepo.getServiceOrderDataByVehicle(
        businessId,
        startDate,
        endDate,
      ),
    ]);

    // Merge fuel and maintenance data by vehicle
    const vehicleCostMap = new Map<
      string,
      { vehicleId: string; vehiclePlate: string; totalCost: number }
    >();

    fuelDataByVehicle.forEach((fuel) => {
      vehicleCostMap.set(fuel.vehicleId, {
        vehicleId: fuel.vehicleId,
        vehiclePlate: fuel.vehiclePlate,
        totalCost: fuel.totalCost,
      });
    });

    maintenanceDataByVehicle.forEach((maintenance) => {
      const existing = vehicleCostMap.get(maintenance.vehicleId);
      if (existing) {
        existing.totalCost += maintenance.totalCost;
      } else {
        vehicleCostMap.set(maintenance.vehicleId, {
          vehicleId: maintenance.vehicleId,
          vehiclePlate: maintenance.vehiclePlate,
          totalCost: maintenance.totalCost,
        });
      }
    });

    const topExpensiveVehicles = Array.from(vehicleCostMap.values())
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 10);

    return {
      totalCost,
      fuelCost,
      maintenanceCost,
      costPerKm,
      costPerRoute,
      costBreakdown: {
        fuel: fuelCost,
        maintenance: maintenanceCost,
      },
      topExpensiveVehicles,
    };
  }

  /**
   * VEHICLE UTILIZATION ANALYTICS
   * Calculates vehicle usage metrics using VehicleRepository and RouteRepository
   */
  private async processVehicleUtilization(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<VehicleUtilizationResults> {
    // Execute both queries in parallel for better performance
    const [statusCounts, utilizationData] = await Promise.all([
      this.vehicleRepo.countVehiclesByStatus(businessId),
      this.vehicleRepo.getVehicleUtilizationData(
        businessId,
        startDate,
        endDate,
      ),
    ]);

    const totalVehiclesWithRoutes = utilizationData.length;
    const totalRoutes = utilizationData.reduce(
      (sum, v) => sum + v.totalRoutes,
      0,
    );

    const totalDistance = utilizationData.reduce(
      (sum, v) => sum + v.totalDistance,
      0,
    );

    const avgRoutesPerVehicle =
      totalVehiclesWithRoutes > 0 ? totalRoutes / totalVehiclesWithRoutes : 0;

    const avgDistancePerVehicle =
      totalVehiclesWithRoutes > 0 ? totalDistance / totalVehiclesWithRoutes : 0;

    // Utilization rate: vehicles with routes / total vehicles
    const utilizationRate =
      statusCounts.totalVehicles > 0
        ? (totalVehiclesWithRoutes / statusCounts.totalVehicles) * 100
        : 0;

    // Sort by total routes to find top utilized and underutilized
    // Add utilizationRate to each vehicle based on their routes vs avg
    const vehiclesWithRate = utilizationData.map((v) => ({
      ...v,
      utilizationRate:
        avgRoutesPerVehicle > 0
          ? (v.totalRoutes / avgRoutesPerVehicle) * 100
          : 0,
    }));

    const sortedByRoutes = [...vehiclesWithRate].sort(
      (a, b) => b.totalRoutes - a.totalRoutes,
    );

    const topUtilizedVehicles = sortedByRoutes.slice(0, 10);
    const underutilizedVehicles = sortedByRoutes.slice(-10).reverse();

    return {
      totalVehicles: statusCounts.totalVehicles,
      activeVehicles: statusCounts.activeVehicles,
      inactiveVehicles: statusCounts.inactiveVehicles,
      blockedVehicles: statusCounts.blockedVehicles,
      inRouteVehicles: statusCounts.inRouteVehicles,
      utilizationRate,
      avgDistancePerVehicle,
      avgRoutesPerVehicle,
      topUtilizedVehicles,
      underutilizedVehicles,
    };
  }

  /**
   * FUEL CONSUMPTION ANALYTICS
   * Calculates fuel metrics using FuelRepository
   */
  private async processFuelConsumption(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<FuelConsumptionResults> {
    // Execute all independent queries in parallel for better performance
    const [
      totalFuelCost,
      totalLiters,
      totalDistance,
      fuelDataByVehicle,
      fuelTypeBreakdown,
    ] = await Promise.all([
      this.fuelRepo.getTotalCostByDateRange(businessId, startDate, endDate),
      this.fuelRepo.getTotalLitersByDateRange(businessId, startDate, endDate),
      this.routeRepo.getTotalDistanceByDateRange(
        businessId,
        startDate,
        endDate,
      ),
      this.fuelRepo.getFuelDataByVehicle(businessId, startDate, endDate),
      this.fuelRepo.getFuelDataByType(businessId, startDate, endDate),
    ]);

    const avgCostPerLiter = totalLiters > 0 ? totalFuelCost / totalLiters : 0;
    const avgConsumption =
      totalDistance > 0 ? totalLiters / (totalDistance / 1000) : 0; // liters per km
    const costPerKm =
      totalDistance > 0 ? totalFuelCost / (totalDistance / 1000) : 0;

    // Sort vehicles by total liters consumed and add avgConsumption
    const topConsumingVehicles = [...fuelDataByVehicle]
      .map((v) => ({
        ...v,
        avgConsumption:
          totalDistance > 0 ? v.totalLiters / (totalDistance / 1000) : 0,
      }))
      .sort((a, b) => b.totalLiters - a.totalLiters)
      .slice(0, 10);

    // Add percentage to fuel type breakdown
    const fuelTypeBreakdownWithPercentage = fuelTypeBreakdown.map((ft) => ({
      ...ft,
      percentage: totalLiters > 0 ? (ft.totalLiters / totalLiters) * 100 : 0,
    }));

    return {
      totalFuelCost,
      totalLiters,
      avgCostPerLiter,
      avgConsumption,
      totalDistance,
      costPerKm,
      topConsumingVehicles,
      fuelTypeBreakdown: fuelTypeBreakdownWithPercentage,
    };
  }

  /**
   * MAINTENANCE COST ANALYTICS
   * Calculates maintenance metrics using ServiceOrderRepository
   */
  private async processMaintenanceCost(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<MaintenanceCostResults> {
    // Execute all independent queries in parallel for better performance
    const [
      totalMaintenanceCost,
      totalServiceOrders,
      costByType,
      serviceOrderDataByVehicle,
      totalDistance,
    ] = await Promise.all([
      this.serviceOrderRepo.getTotalCostByDateRange(
        businessId,
        startDate,
        endDate,
      ),
      this.serviceOrderRepo.getServiceOrderCountByDateRange(
        businessId,
        startDate,
        endDate,
      ),
      this.serviceOrderRepo.getCostByMaintenanceType(
        businessId,
        startDate,
        endDate,
      ),
      this.serviceOrderRepo.getServiceOrderDataByVehicle(
        businessId,
        startDate,
        endDate,
      ),
      this.routeRepo.getTotalDistanceByDateRange(
        businessId,
        startDate,
        endDate,
      ),
    ]);

    const avgCostPerService =
      totalServiceOrders > 0 ? totalMaintenanceCost / totalServiceOrders : 0;

    const costPerKm =
      totalDistance > 0 ? totalMaintenanceCost / (totalDistance / 1000) : 0;

    // Sort vehicles by total maintenance cost and add avgCost
    const topMaintenanceVehicles = [...serviceOrderDataByVehicle]
      .map((v) => ({
        ...v,
        avgCost: v.totalServices > 0 ? v.totalCost / v.totalServices : 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 10);

    return {
      totalMaintenanceCost,
      totalServiceOrders,
      avgCostPerService,
      preventiveCost: costByType.preventive,
      correctiveCost: costByType.corrective,
      costPerKm,
      topMaintenanceVehicles,
      maintenanceTypeBreakdown: {
        preventive: costByType.preventive,
        corrective: costByType.corrective,
      },
    };
  }
}

export { AnalyticsProcessor };
