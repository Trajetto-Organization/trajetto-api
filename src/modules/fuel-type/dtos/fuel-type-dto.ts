import type { SortOrder } from "@/shared/pagination/list-query";
import type { CatalogUsage } from "@/shared/pagination/catalog-usage";
import type {
  FuelTypeListFilters,
  FuelTypeListSearchMeta,
  FuelTypeRefuelingUsage,
  FuelTypeSortKey,
} from "../usecases/list-fuel-type/fuel-type-list";

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
}

interface UpdateFuelType {
  fuelTypeData: UpdateFuelTypeProps;
  fuelTypeId: string;
}

interface ListFuelTypeProps {
  data: FuelType[];
  total: number;
  /** Vehicles per fuel type over the whole search, for the cards. */
  usage: CatalogUsage[];
  /** Refuelings per type inside `refuelWindow`; null when none was asked. */
  refuelings: FuelTypeRefuelingUsage[] | null;
}

/** What the list use case answers: the page, the pager total and the cards. */
interface ListFuelTypeResult {
  data: FuelType[];
  total: number;
  meta: FuelTypeListSearchMeta;
}

interface ListFuelTypeByBusinessIdProps extends FuelTypeListFilters {
  page: number;
  pageSize: number;
  sort?: FuelTypeSortKey;
  order?: SortOrder;
  /**
   * [start, end) of the business month whose refuelings the cards sum.
   * Absent when the caller may not see refuelings: nothing is read then.
   */
  refuelWindow?: { start: Date; end: Date };
}

/** What still points at a fuel type: the guard of its deletion counts them. */
interface FuelTypeUsage {
  vehicles: number;
  fuels: number;
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
  ListFuelTypeResult,
  ListFuelTypeByBusinessIdProps,
  FuelType,
  UpdateFuelTypeProps,
  SearchFuelTypeWithCursorProps,
  CursorPaginatedFuelType,
  FuelTypeUsage,
};
