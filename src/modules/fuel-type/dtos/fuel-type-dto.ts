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
  description?: string | null;
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

interface ListFuelTypeByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

interface SearchFuelTypeWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  search?: string;
}

interface CursorPaginatedFuelType {
  data: FuelType[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  CreateFuelTypeProps,
  UpdateFuelType,
  ListFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  FuelType,
  UpdateFuelTypeProps,
  SearchFuelTypeWithCursorProps,
  CursorPaginatedFuelType,
};
