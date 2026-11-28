import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  ChecklistListFilters,
  ChecklistSortKey,
  ConditionCounts,
  NamedCount,
} from "../usecases/list-vehicle-checklist/checklist-list";

import { ChecklistPhase, RecordOrigin } from "@prisma/client";
import { JsonValue } from "@prisma/client/runtime/client";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";
import type { ListedPhase, ListedRoute } from "@/shared/vehicle/route-columns";

interface VehicleChecklist {
  id: string;
  client_submission_id?: string | null;
  current_mileage: number;
  checklist_date: Date | string;
  tires_condition: string;
  headlights_working: boolean;
  taillights_working: boolean;
  turn_signals_working: boolean;
  bumpers_condition: string;
  windshield_condition: string;
  mirrors_condition: string;
  seatbelts_working: boolean;
  dashboard_working: boolean;
  steering_wheel_condition: string;
  brakes_working: boolean;
  clutch_working: boolean;
  fuel_level_adequate: boolean;
  oil_level_adequate: boolean;
  radiator_water_adequate: boolean;
  brake_fluid_adequate: boolean;
  battery_condition: string;
  driver_license_valid: boolean;
  vehicle_documents_valid: boolean;
  insurance_valid: boolean;
  fire_extinguisher_valid: boolean;
  warning_triangle_present: boolean;
  jack_present: boolean;
  spare_tire_condition: string;
  notes?: string | null;
  photos: string[];
  photos_by_field?: JsonValue;
  ai_verification_status: string;
  ai_verification_details?: any;
  ai_verified_at?: Date | string | null;
  overall_condition: string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  /**
   * The route it was made for and the moment of it (plan of 02/11/2026,
   * C4/F3). STANDALONE and null outside a route.
   */
  routeId?: string | null;
  phase?: ChecklistPhase;
  /**
   * Where it was made: MOBILE_APP or WEB_DASHBOARD, the column's default. A
   * driver's is always MOBILE_APP (shared/vehicle/record-origin.ts).
   */
  created_from?: RecordOrigin;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateVehicleChecklistProps {
  client_submission_id?: string;
  created_from?: RecordOrigin;
  current_mileage: number;
  checklist_date?: Date | string;
  tires_condition: string;
  headlights_working: boolean;
  taillights_working: boolean;
  turn_signals_working: boolean;
  bumpers_condition: string;
  windshield_condition: string;
  mirrors_condition: string;
  seatbelts_working: boolean;
  dashboard_working: boolean;
  steering_wheel_condition: string;
  brakes_working: boolean;
  clutch_working: boolean;
  fuel_level_adequate: boolean;
  oil_level_adequate: boolean;
  radiator_water_adequate: boolean;
  brake_fluid_adequate: boolean;
  battery_condition: string;
  driver_license_valid: boolean;
  vehicle_documents_valid: boolean;
  insurance_valid: boolean;
  fire_extinguisher_valid: boolean;
  warning_triangle_present: boolean;
  jack_present: boolean;
  spare_tire_condition: string;
  notes?: string | null;
  photos?: string[];
  photos_by_field?: Record<string, string[]>;
  overall_condition: string;
  businessId: string;
  branchId?: string; // Optional for driver users (auto-populated)
  vehicleId: string;
  driverId?: string; // Optional for driver users (auto-populated)

  /**
   * C4/F3: the route and the moment. The use case checks the route is the
   * driver's and the vehicle is the route's; absent = STANDALONE.
   */
  routeId?: string | null;
  phase?: ChecklistPhase;

  /**
   * The phone's offline check of the odometer photo, as sent (decision
   * 14.2). The use case moves it to `mileage_device_precheck` or drops it.
   */
  device_precheck?: DevicePrecheck | null;

  /** Where the accepted check is stored; set by the use case only. */
  mileage_device_precheck?: DevicePrecheck;
}

interface UpdateVehicleChecklistProps {
  current_mileage?: number;
  checklist_date?: Date | string;
  tires_condition?: string;
  headlights_working?: boolean;
  taillights_working?: boolean;
  turn_signals_working?: boolean;
  bumpers_condition?: string;
  windshield_condition?: string;
  mirrors_condition?: string;
  seatbelts_working?: boolean;
  dashboard_working?: boolean;
  steering_wheel_condition?: string;
  brakes_working?: boolean;
  clutch_working?: boolean;
  fuel_level_adequate?: boolean;
  oil_level_adequate?: boolean;
  radiator_water_adequate?: boolean;
  brake_fluid_adequate?: boolean;
  battery_condition?: string;
  driver_license_valid?: boolean;
  vehicle_documents_valid?: boolean;
  insurance_valid?: boolean;
  fire_extinguisher_valid?: boolean;
  warning_triangle_present?: boolean;
  jack_present?: boolean;
  spare_tire_condition?: string;
  notes?: string | null;
  photos?: string[];
  overall_condition?: string;
  branchId?: string;
  vehicleId?: string;
  driverId?: string;
}

interface UpdateVehicleChecklist {
  checklistData: Partial<UpdateVehicleChecklistProps>;
  checklistId: string;
}

/**
 * One page plus the raw counts behind its cards and filters (see
 * usecases/list-vehicle-checklist/checklist-list.ts for the summary).
 */
/**
 * A checklist as the list sends it (contract C3): the route it was made for
 * (null outside one or when the route is not the row's company's) and its
 * moment, with STANDALONE as null.
 */
type VehicleChecklistListRow = Omit<VehicleChecklist, "phase"> & {
  route: ListedRoute | null;
  phase: ListedPhase;
};

interface ListVehicleChecklistProps {
  data: VehicleChecklistListRow[];
  /** Grouped over every filter but the condition one. */
  conditionCounts: ConditionCounts;
  /** Grouped over every filter but the branch one, named from this company. */
  branchCounts: NamedCount[];
  /** Grouped over every filter but the vehicle one, named from this company. */
  vehicleCounts: NamedCount[];
}

interface ListVehicleChecklistByBusinessIdProps extends ChecklistListFilters {
  page: number;
  pageSize: number;
  sort?: ChecklistSortKey;
  order?: SortOrder;
}

interface GetVehicleChecklistByIdAndBusinessProps {
  businessId: string;
  checklistId: string;
}

interface VehicleChecklistWithRelations {
  id: string;
  current_mileage: number;
  checklist_date: Date | string;
  tires_condition: string;
  headlights_working: boolean;
  taillights_working: boolean;
  turn_signals_working: boolean;
  bumpers_condition: string;
  windshield_condition: string;
  mirrors_condition: string;
  seatbelts_working: boolean;
  dashboard_working: boolean;
  steering_wheel_condition: string;
  brakes_working: boolean;
  clutch_working: boolean;
  fuel_level_adequate: boolean;
  oil_level_adequate: boolean;
  radiator_water_adequate: boolean;
  brake_fluid_adequate: boolean;
  battery_condition: string;
  driver_license_valid: boolean;
  vehicle_documents_valid: boolean;
  insurance_valid: boolean;
  fire_extinguisher_valid: boolean;
  warning_triangle_present: boolean;
  jack_present: boolean;
  spare_tire_condition: string;
  notes?: string | null;
  photos: string[];
  overall_condition: string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  created_at: Date | string;
  updated_at: Date | string;
  business: {
    id: string;
    corporate_reason: string;
    fantasy_name?: string | null;
  };
  branch: {
    id: string;
    corporate_reason: string;
    fantasy_name?: string | null;
  };
  vehicle: {
    id: string;
    description: string;
    license_plate: string;
    brand: string;
    model: string;
    current_mileage: number;
  };
  driver: {
    id: string;
    name: string;
    cnh: string;
  };
}

/**
 * A checklist made for a route (plan of 02/11/2026, C4): what the driver's
 * payload and the route detail derive "checklist de saída/chegada feito?"
 * from. Never a STANDALONE one.
 */
interface RouteChecklistSummary {
  id: string;
  routeId: string;
  phase: Exclude<ChecklistPhase, "STANDALONE">;
  checklist_date: Date | string;
  overall_condition: string;
}

/**
 * A route of the driver that ended without its arrival checklist (the
 * wave-1 C4 follow-up): what the driver's payload keeps so the app can still
 * ask for it after the last stop resolved and the route left the list.
 */
interface RouteAwaitingEndChecklist {
  id: string;
  code: number;
  plan_version: number;
  vehicle: { id: string; license_plate: string } | null;
  completed_at: Date | null;
}

export {
  RouteAwaitingEndChecklist,
  RouteChecklistSummary,
  VehicleChecklist,
  CreateVehicleChecklistProps,
  UpdateVehicleChecklistProps,
  UpdateVehicleChecklist,
  ListVehicleChecklistProps,
  VehicleChecklistListRow,
  ListVehicleChecklistByBusinessIdProps,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
};
