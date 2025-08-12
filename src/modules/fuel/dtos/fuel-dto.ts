import { Decimal } from "@prisma/client/runtime/library";

interface Fuel {
  id: string;
  current_mileage: number;
  liters_amount: Decimal;
  price_per_liter: Decimal;
  total_amount: Decimal;
  odometer_photo?: string | null;
  odometer_verified: boolean;
  notes?: string | null;
  refueling_date: Date | string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateFuelProps {
  current_mileage: number;
  liters_amount: number | string | Decimal;
  price_per_liter: number | string | Decimal;
  total_amount?: number | string | Decimal;
  odometer_photo?: string | null;
  odometer_verified?: boolean;
  notes?: string | null;
  refueling_date: Date | string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;
}

interface UpdateFuelProps {
  current_mileage?: number;
  liters_amount?: number | string | Decimal;
  price_per_liter?: number | string | Decimal;
  total_amount?: number | string | Decimal;
  odometer_photo?: string | null;
  odometer_verified?: boolean;
  notes?: string | null;
  refueling_date?: Date | string;
  branchId?: string;
  vehicleId?: string;
  driverId?: string;
  fuelTypeId?: string;
}

interface UpdateFuel {
  fuelData: Partial<UpdateFuelProps>;
  fuelId: string;
}

interface FuelFormatted {
  id: string;
  current_mileage: number;
  liters_amount: string;
  price_per_liter: string;
  total_amount: string;
  odometer_photo?: string | null;
  odometer_verified: boolean;
  notes?: string | null;
  refueling_date: string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;
  business_name?: string;
  branch_name: string;
  vehicle_description: string;
  vehicle_license_plate: string;
  vehicle_brand: string;
  vehicle_model: string;
  driver_name: string;
  driver_cnh: string;
  fuel_type_description: string;
  created_at: string;
  updated_at: string;
}

interface FuelWithRelationsFormatted {
  id: string;
  current_mileage: number;
  liters_amount: string;
  price_per_liter: string;
  total_amount: string;
  odometer_photo?: string | null;
  odometer_verified: boolean;
  notes?: string | null;
  refueling_date: string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;
  created_at: string;
  updated_at: string;
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
  fuelType: {
    id: string;
    description: string;
  };
}

interface ListFuelProps {
  data: Fuel[];
  total: number;
}

interface ListFuelFormattedProps {
  data: FuelFormatted[];
  total: number;
}

interface ListFuelBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface ListFuelByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
  vehicleId?: string;
  driverId?: string;
  fuelTypeId?: string;
  startDate?: string | Date;
  endDate?: string | Date;
}

interface GetFuelByIdAndBusinessProps {
  businessId: string;
  fuelId: string;
}

interface FuelWithRelations {
  id: string;
  current_mileage: number;
  liters_amount: Decimal;
  price_per_liter: Decimal;
  total_amount: Decimal;
  odometer_photo?: string | null;
  odometer_verified: boolean;
  notes?: string | null;
  refueling_date: Date | string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;
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
  fuelType: {
    id: string;
    description: string;
  };
}

export {
  Fuel,
  CreateFuelProps,
  UpdateFuelProps,
  UpdateFuel,
  ListFuelProps,
  ListFuelFormattedProps,
  ListFuelByBusinessIdProps,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  FuelWithRelations,
  FuelFormatted,
  FuelWithRelationsFormatted,
};
