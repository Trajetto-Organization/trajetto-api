interface FuelType {
  id: string;
  description: string;
  businessId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateFuelTypeProps {
  description: string;
  businessId: string;
}

interface UpdateFuelTypeProps {
  description?: string;
  businessId?: string;
}

interface UpdateFuelType {
  fuelTypeData: UpdateFuelTypeProps;
  fuelTypeId: string;
}

interface ListFuelTypeProps {
  data: FuelType[];
  total: number;
}

interface ListFuelTypeBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface ListFuelTypeByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

export {
  CreateFuelTypeProps,
  UpdateFuelType,
  ListFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  ListFuelTypeBusinessProps,
  FuelType,
  UpdateFuelTypeProps,
};
