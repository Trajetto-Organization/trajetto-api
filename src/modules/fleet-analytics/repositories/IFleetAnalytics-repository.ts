import {
  FleetAnalytics,
  CreateFleetAnalyticsProps,
  UpdateFleetAnalyticsProps,
  ListFleetAnalyticsProps,
  ListFleetAnalyticsResult,
} from "../dtos/fleet-analytics-dto";

interface IFleetAnalyticsRepository {
  create: (data: CreateFleetAnalyticsProps) => Promise<FleetAnalytics>;
  listByBusiness: (
    props: ListFleetAnalyticsProps,
  ) => Promise<ListFleetAnalyticsResult>;
  findById: (id: string) => Promise<FleetAnalytics | null>;
  findByBusinessAndId: (
    analyticsId: string,
    businessId: string,
  ) => Promise<FleetAnalytics | null>;
  update: (props: UpdateFleetAnalyticsProps) => Promise<FleetAnalytics>;
  delete: (id: string) => Promise<FleetAnalytics>;
  countByBusiness: (businessId: string) => Promise<number>;
  findByType: (
    analyticsType: string,
    businessId: string,
  ) => Promise<FleetAnalytics[]>;
  findByPeriod: (
    period: string,
    businessId: string,
  ) => Promise<FleetAnalytics[]>;
  findByDateRange: (
    startDate: Date,
    endDate: Date,
    businessId: string,
  ) => Promise<FleetAnalytics[]>;
}

export { IFleetAnalyticsRepository };
