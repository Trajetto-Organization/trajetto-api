import database from "@/../infra/database";
import { IFleetAnalyticsRepository } from "./IFleetAnalytics-repository";

import {
  FleetAnalytics,
  CreateFleetAnalyticsProps,
  UpdateFleetAnalyticsProps,
  ListFleetAnalyticsProps,
  ListFleetAnalyticsResult,
  AnalyticsResults,
} from "../dtos/fleet-analytics-dto";

class FleetAnalyticsRepository implements IFleetAnalyticsRepository {
  constructor(private prisma = database) {}

  async create(data: CreateFleetAnalyticsProps): Promise<FleetAnalytics> {
    const analytics = await this.prisma.fleetAnalytics.create({
      data: {
        analyticsType: data.analyticsType,
        period: data.period,
        startDate: data.startDate,
        endDate: data.endDate,
        results: data.results as any,
        metadata: (data.metadata || {}) as any,
        businessId: data.businessId,
      },
    });

    return this.transformAnalyticsData(analytics);
  }

  async listByBusiness(
    props: ListFleetAnalyticsProps,
  ): Promise<ListFleetAnalyticsResult> {
    const skip = (props.page - 1) * props.pageSize;

    const whereCondition: any = {
      businessId: props.businessId,
      ...(props.analyticsType && { analyticsType: props.analyticsType }),
      ...(props.period && { period: props.period }),
      ...(props.startDate &&
        props.endDate && {
          startDate: { gte: props.startDate },
          endDate: { lte: props.endDate },
        }),
    };

    const [analyticsData, total] = await Promise.all([
      this.prisma.fleetAnalytics.findMany({
        skip,
        take: props.pageSize,
        where: whereCondition,
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.fleetAnalytics.count({ where: whereCondition }),
    ]);

    const transformedAnalyticsData = analyticsData.map((analytics) =>
      this.transformAnalyticsData(analytics),
    );

    return {
      data: transformedAnalyticsData,
      total,
    };
  }

  async findById(id: string): Promise<FleetAnalytics | null> {
    const analytics = await this.prisma.fleetAnalytics.findUnique({
      where: { id },
    });

    if (!analytics) return null;

    return this.transformAnalyticsData(analytics);
  }

  async findByBusinessAndId(
    analyticsId: string,
    businessId: string,
  ): Promise<FleetAnalytics | null> {
    const analytics = await this.prisma.fleetAnalytics.findFirst({
      where: {
        id: analyticsId,
        businessId,
      },
    });

    if (!analytics) return null;

    return this.transformAnalyticsData(analytics);
  }

  async update(props: UpdateFleetAnalyticsProps): Promise<FleetAnalytics> {
    const analytics = await this.prisma.fleetAnalytics.update({
      where: { id: props.id },
      data: {
        analyticsType: props.analyticsType,
        period: props.period,
        startDate: props.startDate,
        endDate: props.endDate,
        results: props.results as any,
        metadata: props.metadata as any,
      },
    });

    return this.transformAnalyticsData(analytics);
  }

  async delete(id: string): Promise<FleetAnalytics> {
    const analytics = await this.prisma.fleetAnalytics.delete({
      where: { id },
    });

    return this.transformAnalyticsData(analytics);
  }

  async countByBusiness(businessId: string): Promise<number> {
    return this.prisma.fleetAnalytics.count({
      where: { businessId },
    });
  }

  async findByType(
    analyticsType: string,
    businessId: string,
  ): Promise<FleetAnalytics[]> {
    const analytics = await this.prisma.fleetAnalytics.findMany({
      where: {
        analyticsType,
        businessId,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    return analytics.map((item) => this.transformAnalyticsData(item));
  }

  async findByPeriod(
    period: string,
    businessId: string,
  ): Promise<FleetAnalytics[]> {
    const analytics = await this.prisma.fleetAnalytics.findMany({
      where: {
        period,
        businessId,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    return analytics.map((item) => this.transformAnalyticsData(item));
  }

  async findByDateRange(
    startDate: Date,
    endDate: Date,
    businessId: string,
  ): Promise<FleetAnalytics[]> {
    const analytics = await this.prisma.fleetAnalytics.findMany({
      where: {
        businessId,
        startDate: { gte: startDate },
        endDate: { lte: endDate },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    return analytics.map((item) => this.transformAnalyticsData(item));
  }

  private transformAnalyticsData(data: any): FleetAnalytics {
    return {
      id: data.id,
      analyticsType: data.analyticsType,
      period: data.period,
      startDate: data.startDate,
      endDate: data.endDate,
      results: data.results as AnalyticsResults,
      metadata: (data.metadata as Record<string, unknown>) || null,
      businessId: data.businessId,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }
}

export { FleetAnalyticsRepository };
