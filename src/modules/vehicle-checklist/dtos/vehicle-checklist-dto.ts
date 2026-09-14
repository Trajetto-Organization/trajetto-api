import { RecordOrigin } from "@prisma/client";
import { JsonValue } from "@prisma/client/runtime/library";

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

interface ListVehicleChecklistProps {
  data: VehicleChecklist[];
  total: number;
}

interface ListVehicleChecklistByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
  vehicleId?: string;
  driverId?: string;
  overall_condition?: string;
  startDate?: string | Date;
  endDate?: string | Date;
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
