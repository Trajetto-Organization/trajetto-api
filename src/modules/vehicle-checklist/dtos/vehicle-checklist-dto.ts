import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  ChecklistListFilters,
  ChecklistSortKey,
  ConditionCounts,
  NamedCount,
} from "../usecases/list-vehicle-checklist/checklist-list";

import { RecordOrigin } from "@prisma/client";
import { JsonValue } from "@prisma/client/runtime/client";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";

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
interface ListVehicleChecklistProps {
  data: VehicleChecklist[];
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

export {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  UpdateVehicleChecklistProps,
  UpdateVehicleChecklist,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
};
