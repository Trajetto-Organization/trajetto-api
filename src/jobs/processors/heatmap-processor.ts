import { FineRepository } from "@/modules/fine/repositories/fine-repository";

import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";
import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";

import {
  HeatmapResults,
  HeatmapPoint,
  FineWithLocation,
  FuelWithLocation,
  ServiceOrderWithLocation,
} from "@/modules/heatmap/dtos/heatmap-dto";

class HeatmapProcessor {
  private fineRepo: FineRepository;
  private fuelRepo: FuelRepository;

  private serviceOrderRepo: ServiceOrderRepository;

  constructor() {
    this.fineRepo = new FineRepository();
    this.fuelRepo = new FuelRepository();

    this.serviceOrderRepo = new ServiceOrderRepository();
  }

  async process(jobData: any): Promise<void> {
    const { heatmapType, businessId, startDate, endDate, vehicleId, filters } =
      jobData.data;

    console.log(
      `[HeatmapProcessor] Processing ${heatmapType} heatmap for business ${businessId}`,
    );

    let results: HeatmapResults;

    switch (heatmapType) {
      case "fines":
        results = await this.processFinesHeatmap(
          businessId,
          startDate,
          endDate,
          vehicleId,
          filters,
        );
        break;
      case "fuel":
        results = await this.processFuelHeatmap(
          businessId,
          startDate,
          endDate,
          vehicleId,
          filters,
        );
        break;
      case "maintenance":
        results = await this.processMaintenanceHeatmap(
          businessId,
          startDate,
          endDate,
          vehicleId,
          filters,
        );
        break;
      default:
        throw new Error(`Unknown heatmap type: ${heatmapType}`);
    }

    console.log(
      `[HeatmapProcessor] Heatmap ${heatmapType} completed with ${results.points.length} points`,
    );

    // Returns the result (will be captured by the worker)
    return results as any;
  }

  private async processFinesHeatmap(
    businessId: string,
    startDate: Date,
    endDate: Date,
    vehicleId?: string,
    filters?: any,
  ): Promise<HeatmapResults> {
    // Search for fines by location.
    const fines = await this.fineRepo.getFinesWithLocation(
      businessId,
      new Date(startDate),
      new Date(endDate),
      vehicleId,
    );

    if (fines.length === 0) {
      return this.createEmptyHeatmap("fines", startDate, endDate);
    }

    // Grouping nearby coordinates (clustering)
    const clustered = this.clusterPoints(
      fines.map((f) => ({ lat: f.lat, lng: f.lng, value: f.amount })),
    );

    // Normalizes intensities
    const maxValue = Math.max(...clustered.map((c) => c.value));
    const points: HeatmapPoint[] = clustered.map((cluster) => ({
      lat: cluster.lat,
      lng: cluster.lng,
      intensity: maxValue > 0 ? cluster.value / maxValue : 0, // 0.0 - 1.0
      value: cluster.value,
      count: cluster.count,
    }));

    // Generates automatic insights.
    const insights = this.generateFineInsights(fines, points);

    return {
      type: "fines",
      period: { startDate: new Date(startDate), endDate: new Date(endDate) },
      points,
      statistics: {
        totalValue: fines.reduce((sum, f) => sum + f.amount, 0),
        totalCount: fines.length,
        maxIntensity: maxValue,
        averageValue:
          fines.reduce((sum, f) => sum + f.amount, 0) / fines.length || 0,
      },
      insights,
      generated_at: new Date(),
    };
  }

  private async processFuelHeatmap(
    businessId: string,
    startDate: Date,
    endDate: Date,
    vehicleId?: string,
    filters?: any,
  ): Promise<HeatmapResults> {
    const fuels = await this.fuelRepo.getFuelWithLocation(
      businessId,
      new Date(startDate),
      new Date(endDate),
      vehicleId,
    );

    if (fuels.length === 0) {
      return this.createEmptyHeatmap("fuel", startDate, endDate);
    }

    const clustered = this.clusterPoints(
      fuels.map((f) => ({ lat: f.lat, lng: f.lng, value: f.cost })),
    );

    const maxValue = Math.max(...clustered.map((c) => c.value));
    const points: HeatmapPoint[] = clustered.map((cluster) => ({
      lat: cluster.lat,
      lng: cluster.lng,
      intensity: maxValue > 0 ? cluster.value / maxValue : 0,
      value: cluster.value,
      count: cluster.count,
    }));

    const insights = this.generateFuelInsights(fuels, points);

    return {
      type: "fuel",
      period: { startDate: new Date(startDate), endDate: new Date(endDate) },
      points,
      statistics: {
        totalValue: fuels.reduce((sum, f) => sum + f.cost, 0),
        totalCount: fuels.length,
        maxIntensity: maxValue,
        averageValue:
          fuels.reduce((sum, f) => sum + f.cost, 0) / fuels.length || 0,
      },
      insights,
      generated_at: new Date(),
    };
  }

  private async processMaintenanceHeatmap(
    businessId: string,
    startDate: Date,
    endDate: Date,
    vehicleId?: string,
    filters?: any,
  ): Promise<HeatmapResults> {
    const orders = await this.serviceOrderRepo.getServiceOrdersWithLocation(
      businessId,
      new Date(startDate),
      new Date(endDate),
      vehicleId,
    );

    if (orders.length === 0) {
      return this.createEmptyHeatmap("maintenance", startDate, endDate);
    }

    const clustered = this.clusterPoints(
      orders.map((o) => ({ lat: o.lat, lng: o.lng, value: o.cost })),
    );

    const maxValue = Math.max(...clustered.map((c) => c.value));
    const points: HeatmapPoint[] = clustered.map((cluster) => ({
      lat: cluster.lat,
      lng: cluster.lng,
      intensity: maxValue > 0 ? cluster.value / maxValue : 0,
      value: cluster.value,
      count: cluster.count,
    }));

    const insights = this.generateMaintenanceInsights(orders, points);

    return {
      type: "maintenance",
      period: { startDate: new Date(startDate), endDate: new Date(endDate) },
      points,
      statistics: {
        totalValue: orders.reduce((sum, o) => sum + o.cost, 0),
        totalCount: orders.length,
        maxIntensity: maxValue,
        averageValue:
          orders.reduce((sum, o) => sum + o.cost, 0) / orders.length || 0,
      },
      insights,
      generated_at: new Date(),
    };
  }

  // Simple clustering: groups nearby points (radius of ~100m)
  private clusterPoints(
    points: Array<{ lat: number; lng: number; value: number }>,
  ): Array<{ lat: number; lng: number; value: number; count: number }> {
    const clusters: Array<{
      lat: number;
      lng: number;
      value: number;
      count: number;
    }> = [];
    const CLUSTER_RADIUS = 0.001; // ~100m in degrees

    points.forEach((point) => {
      // Search for existing cluster nearby
      const existingCluster = clusters.find(
        (c) =>
          Math.abs(c.lat - point.lat) < CLUSTER_RADIUS &&
          Math.abs(c.lng - point.lng) < CLUSTER_RADIUS,
      );

      if (existingCluster) {
        // Adds to the existing cluster (weighted average of coordinates)
        existingCluster.lat =
          (existingCluster.lat * existingCluster.count + point.lat) /
          (existingCluster.count + 1);
        existingCluster.lng =
          (existingCluster.lng * existingCluster.count + point.lng) /
          (existingCluster.count + 1);
        existingCluster.value += point.value;
        existingCluster.count += 1;
      } else {
        // Create new cluster
        clusters.push({ ...point, count: 1 });
      }
    });

    return clusters;
  }

  private generateFineInsights(
    fines: FineWithLocation[],
    points: HeatmapPoint[],
  ): string[] {
    const insights: string[] = [];

    if (points.length === 0)
      return ["Nenhuma multa com localização encontrada no período."];

    // Top 3 locations with the most fines.
    const topPoints = [...points].sort((a, b) => b.count - a.count).slice(0, 3);
    if (topPoints.length > 0) {
      insights.push(
        `Região com mais multas: ${topPoints[0].count} multas (${((topPoints[0].count / fines.length) * 100).toFixed(1)}% do total)`,
      );
    }

    // Total value
    const totalValue = fines.reduce((sum, f) => sum + f.amount, 0);
    insights.push(`Valor total em multas: R$ ${totalValue.toFixed(2)}`);

    // Average per fine
    const avgValue = totalValue / fines.length;
    insights.push(`Valor médio por multa: R$ ${avgValue.toFixed(2)}`);

    return insights;
  }

  private generateFuelInsights(
    fuels: FuelWithLocation[],
    points: HeatmapPoint[],
  ): string[] {
    const insights: string[] = [];

    if (points.length === 0)
      return ["Nenhum abastecimento com localização encontrado no período."];

    const topPoints = [...points].sort((a, b) => b.count - a.count).slice(0, 3);
    if (topPoints.length > 0) {
      insights.push(
        `Posto mais utilizado: ${topPoints[0].count} abastecimentos (${((topPoints[0].count / fuels.length) * 100).toFixed(1)}% do total)`,
      );
    }

    const totalCost = fuels.reduce((sum, f) => sum + f.cost, 0);
    const totalLiters = fuels.reduce((sum, f) => sum + f.liters, 0);

    insights.push(`Custo total em combustível: R$ ${totalCost.toFixed(2)}`);
    insights.push(`Total de litros: ${totalLiters.toFixed(2)}L`);

    const avgCostPerLiter = totalCost / totalLiters;
    if (!isNaN(avgCostPerLiter)) {
      insights.push(
        `Preço médio por litro: R$ ${avgCostPerLiter.toFixed(2)}/L`,
      );
    }

    return insights;
  }

  private generateMaintenanceInsights(
    orders: ServiceOrderWithLocation[],
    points: HeatmapPoint[],
  ): string[] {
    const insights: string[] = [];

    if (points.length === 0)
      return ["Nenhuma manutenção com localização encontrada no período."];

    const topPoints = [...points].sort((a, b) => b.count - a.count).slice(0, 3);
    if (topPoints.length > 0) {
      insights.push(
        `Oficina mais utilizada: ${topPoints[0].count} serviços (${((topPoints[0].count / orders.length) * 100).toFixed(1)}% do total)`,
      );
    }

    const totalCost = orders.reduce((sum, o) => sum + o.cost, 0);
    insights.push(`Custo total em manutenção: R$ ${totalCost.toFixed(2)}`);

    const avgCost = totalCost / orders.length;
    insights.push(`Custo médio por serviço: R$ ${avgCost.toFixed(2)}`);

    // Analysis by type of maintenance
    const preventive = orders.filter((o) => o.maintenanceType === "INTERNAL");
    const corrective = orders.filter((o) => o.maintenanceType === "EXTERNAL");

    if (preventive.length > 0 || corrective.length > 0) {
      insights.push(
        `Manutenções preventivas: ${preventive.length} | Corretivas: ${corrective.length}`,
      );
    }

    return insights;
  }

  private createEmptyHeatmap(
    type: "fines" | "fuel" | "maintenance",
    startDate: Date,
    endDate: Date,
  ): HeatmapResults {
    return {
      type,
      period: { startDate: new Date(startDate), endDate: new Date(endDate) },
      points: [],
      statistics: {
        totalValue: 0,
        totalCount: 0,
        maxIntensity: 0,
        averageValue: 0,
      },
      insights: ["Nenhum dado com localização encontrado para o período."],
      generated_at: new Date(),
    };
  }
}

export { HeatmapProcessor };
