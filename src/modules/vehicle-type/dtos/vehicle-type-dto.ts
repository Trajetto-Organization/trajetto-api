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
  description?: string | null;
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

interface ListVehicleTypeByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

interface SearchVehicleTypeWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedVehicleType {
  data: VehicleType[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  VehicleType,
  CreateVehicleTypeProps,
  UpdateVehicleType,
  ListVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  UpdateVehicleTypeProps,
  SearchVehicleTypeWithCursorProps,
  CursorPaginatedVehicleType,
};
