import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  VehicleBranchCount,
  VehicleListFilters,
  VehicleSortKey,
} from "../usecases/list-vehicle/vehicle-list";

interface Vehicle {
  id: string;
  description: string;
  license_plate: string;
  brand: string;
  model: string;
  acquisition_date: Date | string;
  fleet_type: "OWNED" | "THIRD_PARTY";
  fleet_id?: string | null;
  last_maintenance_date?: Date | null | string;
  current_mileage: number;
  last_maintenance_mileage?: number | null;
  maintenance_interval_km: number;
  maintenance_interval_months: number;
  renavam: string;
  manufacturing_year: Date;
  model_year: Date;
  km_per_liter: number;
  number_of_axles: number;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED" | "IN_ROUTE";
  businessId: string;
  vehicleTypeId?: string | null;
  fuelTypeId: string;
  driverId?: string | null;
  branchId?: string | null;
  /**
   * Who answers for the vehicle in the company (plan of 02/11/2026, F1):
   * the person a failed checklist alerts. Null = the company's admins.
   */
  responsibleUserId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateVehicleProps {
  description: string;
  license_plate: string;
  brand: string;
  model: string;
  acquisition_date: Date | string;
  fleet_type: "OWNED" | "THIRD_PARTY";
  fleet_id?: string | null;
  last_maintenance_date?: Date | null | string;
  current_mileage: number;
  last_maintenance_mileage?: number | null;
  maintenance_interval_km: number;
  maintenance_interval_months: number;
  renavam: string;
  manufacturing_year: Date | string;
  model_year: Date | string;
  km_per_liter: number;
  number_of_axles: number;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED" | "IN_ROUTE";
  businessId: string;
  vehicleTypeId?: string | null;
  fuelTypeId: string;
  driverId?: string | null;
  branchId?: string | null;
  /** F1. The use case checks it is a user of the same company. */
  responsibleUserId?: string | null;
}

interface UpdateVehicleProps {
  description?: string;
  license_plate?: string;
  brand?: string;
  model?: string;
  acquisition_date?: Date | string;
  fleet_type?: "OWNED" | "THIRD_PARTY";
  fleet_id?: string | null;
  last_maintenance_date?: Date | null | string;
  current_mileage?: number | null;
  last_maintenance_mileage?: number | null;
  maintenance_interval_km?: number;
  maintenance_interval_months?: number;
  renavam?: string;
  manufacturing_year?: Date | string;
  model_year?: Date | string;
  km_per_liter?: number;
  number_of_axles?: number;
  status?: "ACTIVE" | "INACTIVE" | "BLOCKED" | "IN_ROUTE";
  vehicleTypeId?: string | null;
  fuelTypeId?: string;
  driverId?: string | null;
  branchId?: string | null;
  /** F1. Null hands the vehicle back to the admins; undefined keeps it. */
  responsibleUserId?: string | null;
}

interface UpdateVehicle {
  vehicleData: UpdateVehicleProps;
  vehicleId: string;

  /**
   * Unblocking a truck whose route is still on the road (decision 8.3): the
   * status is the route's, read in the write's own transaction under the
   * running route's lock — IN_ROUTE while it runs, ACTIVE once it ended —
   * instead of `vehicleData.status`, which the caller decided on an older
   * read. The company scopes that read.
   */
  statusFromRunningRoute?: { businessId: string };
}

/**
 * Fleet-wide tally behind the four cards on the vehicle page. Counted over the
 * SAME filter that produced `total`, so the four always add up to it — the
 * cards used to be filtered client-side over the current page, which made them
 * report the page (ten rows) as if it were the fleet.
 */
interface VehicleStatusCounts {
  ACTIVE: number;
  INACTIVE: number;
  BLOCKED: number;
  IN_ROUTE: number;
}

/**
 * The names the vehicle form and the service order prefill read (plan of
 * 02/11/2026, F1 and F4): the fleet's responsible user and the branch, null
 * without one. `branch.name` is the label every branch picker shows (the
 * corporate reason); `corporate_reason` stays for the clients that read it.
 */
interface VehicleRelationNames {
  responsibleUser: { name: string } | null;
  branch: { corporate_reason: string; name: string } | null;
}

/** One vehicle as the detail reads it, with those names. */
type VehicleDetail = Vehicle & VehicleRelationNames;

/**
 * One page of the listing plus the raw counts behind its cards and filters
 * (see usecases/list-vehicle/vehicle-list.ts for how they are summarised).
 */
interface ListVehicleProps {
  data: Array<Vehicle & VehicleRelationNames>;
  /** Grouped over every filter but status. */
  statusCounts: VehicleStatusCounts;
  /** Grouped over every filter but branch, with this company's names. */
  branchCounts: VehicleBranchCount[];
}

interface ListVehicleByBusinessIdProps extends VehicleListFilters {
  page: number;
  pageSize: number;
  sort?: VehicleSortKey;
  order?: SortOrder;
}

interface GetVehicleByIdAndBusinessProps {
  businessId: string;
  vehicleId: string;
}

interface VehicleWithLastFuel extends Vehicle, Partial<VehicleRelationNames> {
  last_fuel_mileage?: number | null;
  last_fuel_date?: Date | string | null;
}

interface SearchVehicleWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  /**
   * Only the vehicles this driver may operate: the responsible one, or one
   * on a released or running route of theirs (shared/vehicle/driver-vehicle-access).
   */
  driverId?: string;
  search?: string;
  /**
   * `choice`: only what a picker needs to choose a vehicle (DLV-COMBO-1), for
   * a dispatcher who reaches the search through `delivery_manage:write`
   * without reading the fleet.
   */
  fields?: "full" | "choice";
}

/** What a picker needs to choose a vehicle, and nothing of the fleet record. */
interface VehicleChoice {
  id: string;
  description: string;
  license_plate: string;
  brand: string;
  model: string;
  status: Vehicle["status"];
  businessId: string;
  driverId?: string | null;
  vehicleTypeId?: string | null;
  /** The responsible driver's name, so the picker can say whose truck it is. */
  driver?: { name: string } | null;
  /** The type and the licence it requires (decision 8.5). */
  vehicleType?: {
    description: string;
    required_cnh_category: string | null;
  } | null;
}

interface CursorPaginatedVehicle {
  data: Array<Vehicle | VehicleChoice>;
  nextCursor: string | null;
  hasMore: boolean;
}

/** What still points at a vehicle and blocks deleting it (FLEET-VEH-10). */
interface VehicleUsageCounts {
  fines: number;
  fuels: number;
  serviceOrders: number;
  checklists: number;
  accountsPayable: number;
}

export {
  Vehicle,
  CreateVehicleProps,
  UpdateVehicleProps,
  UpdateVehicle,
  ListVehicleProps,
  VehicleStatusCounts,
  ListVehicleByBusinessIdProps,
  GetVehicleByIdAndBusinessProps,
  VehicleWithLastFuel,
  VehicleDetail,
  VehicleRelationNames,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
  VehicleChoice,
  VehicleUsageCounts,
};
