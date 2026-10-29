import type { CnhCategory } from "@prisma/client";

import type { SortOrder } from "@/shared/pagination/list-query";
import type { CatalogUsage } from "@/shared/pagination/catalog-usage";

import type {
  VehicleTypeListFilters,
  VehicleTypeListSearchMeta,
  VehicleTypeSortKey,
} from "../usecases/list-vehicle-type/vehicle-type-list";

interface VehicleType {
  id: string;
  description: string;
  number_of_axles: number;
  /** The licence this kind of vehicle needs (decision 8.5); null = not set. */
  required_cnh_category: CnhCategory | null;
  businessId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** A row of the listing: the type plus how many vehicles use it. */
interface VehicleTypeListRow extends VehicleType {
  _count: { vehicles: number };
}

interface CreateVehicleTypeProps {
  description: string;
  number_of_axles: number;
  required_cnh_category?: CnhCategory | null;
  businessId: string;
}

interface UpdateVehicleTypeProps {
  description?: string | null;
  number_of_axles?: number;
  /** `null` clears it; absent leaves it. */
  required_cnh_category?: CnhCategory | null;
}

interface UpdateVehicleType {
  vehicleTypeData: UpdateVehicleTypeProps;
  vehicleTypeId: string;
}

interface ListVehicleTypeProps {
  data: VehicleTypeListRow[];
  total: number;
  /** Vehicles per type over the whole search, for the cards. */
  usage: CatalogUsage[];
}

/** What the list use case answers: the page, the pager total and the cards. */
interface ListVehicleTypeResult {
  data: VehicleTypeListRow[];
  total: number;
  meta: VehicleTypeListSearchMeta;
}

interface ListVehicleTypeByBusinessIdProps extends VehicleTypeListFilters {
  page: number;
  pageSize: number;
  sort?: VehicleTypeSortKey;
  order?: SortOrder;
}

interface SearchVehicleTypeWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  search?: string;
}

interface CursorPaginatedVehicleType {
  data: VehicleType[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  VehicleType,
  VehicleTypeListRow,
  CreateVehicleTypeProps,
  UpdateVehicleType,
  ListVehicleTypeProps,
  ListVehicleTypeResult,
  ListVehicleTypeByBusinessIdProps,
  UpdateVehicleTypeProps,
  SearchVehicleTypeWithCursorProps,
  CursorPaginatedVehicleType,
};
