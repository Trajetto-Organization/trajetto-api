interface VehicleType {
  id: string;
  description: string;
  number_of_axles: number;
  businessId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateVehicleTypeProps {
  description: string;
  number_of_axles: number;
  businessId: string;
}

interface UpdateVehicleTypeProps {
  description?: string;
  number_of_axles?: number;
  businessId?: string;
}

interface UpdateVehicleType {
  vehicleTypeData: UpdateVehicleTypeProps;
  vehicleTypeId: string;
}

interface ListVehicleTypeProps {
  data: VehicleType[];
  total: number;
}

interface ListVehicleTypeBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface ListVehicleTypeByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

export {
  VehicleType,
  CreateVehicleTypeProps,
  UpdateVehicleType,
  ListVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  ListVehicleTypeBusinessProps,
  UpdateVehicleTypeProps,
};
