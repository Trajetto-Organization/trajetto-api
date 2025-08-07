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
}

interface UpdateVehicleProps {
  description?: string;
  brand?: string;
  model?: string;
  acquisition_date?: Date | string;
  fleet_type?: "OWNED" | "THIRD_PARTY";
  fleet_id?: string | null;
  last_maintenance_date?: Date | null | string;
  current_mileage?: number;
  last_maintenance_mileage?: number | null;
  maintenance_interval_km?: number;
  maintenance_interval_months?: number;
  manufacturing_year?: Date | string;
  model_year?: Date | string;
  km_per_liter?: number;
  number_of_axles?: number;
  status?: "ACTIVE" | "INACTIVE" | "BLOCKED" | "IN_ROUTE";
  vehicleTypeId?: string | null;
  fuelTypeId?: string;
  driverId?: string | null;
  branchId?: string | null;
}

interface UpdateVehicle {
  vehicleData: Partial<CreateVehicleProps>;
  vehicleId: string;
}

interface ListVehicleProps {
  data: Vehicle[];
  total: number;
}

interface ListVehicleBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface ListVehicleByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

interface GetVehicleByIdAndBusinessProps {
  businessId: string;
  vehicleId: string;
}

export {
  Vehicle,
  CreateVehicleProps,
  UpdateVehicleProps,
  UpdateVehicle,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  ListVehicleBusinessProps,
  GetVehicleByIdAndBusinessProps,
};
