import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";
import {
  summarizeCatalogUsage,
  type CatalogLeader,
  type CatalogUsage,
} from "@/shared/pagination/catalog-usage";

/**
 * The vehicle-type listing's server-side order and search (decision 8.8).
 * No facets: the table has none; the pager and the cards count the search.
 */

/** Same ids as the web table's columns. */
const VEHICLE_TYPE_SORT_KEYS = [
  "created_at",
  "description",
  "number_of_axles",
  "required_cnh_category",
  "vehicleCount",
] as const;

type VehicleTypeSortKey = (typeof VEHICLE_TYPE_SORT_KEYS)[number];

const VEHICLE_TYPE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.VehicleTypeOrderByWithRelationInput;

const VEHICLE_TYPE_SORT: SortSpec<VehicleTypeSortKey, OrderBy> = {
  keys: VEHICLE_TYPE_SORT_KEYS,
  fallback: VEHICLE_TYPE_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    description: (order: SortOrder) => ({ description: order }),
    number_of_axles: (order: SortOrder) => ({ number_of_axles: order }),
    required_cnh_category: (order: SortOrder) => ({
      required_cnh_category: order,
    }),
    vehicleCount: (order: SortOrder) => ({ vehicles: { _count: order } }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface VehicleTypeListFilters {
  businessId: string;
  search?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function vehicleTypeListWhere(
  filters: VehicleTypeListFilters,
): Prisma.VehicleTypeWhereInput {
  const term = filters.search?.trim() ?? "";

  if (!term) return { businessId: filters.businessId };

  return {
    businessId: filters.businessId,
    ...buildSearchOr<Prisma.VehicleTypeWhereInput>([
      ...(UUID_PATTERN.test(term) ? [{ id: term }] : []),
      { description: { contains: term, mode: "insensitive" } },
      ...(/^\d+$/.test(term) && Number(term) <= 1000
        ? [{ number_of_axles: Number(term) }]
        : []),
    ]),
  };
}

/** The cards (`meta.searchMeta`), over every type the search finds. */
interface VehicleTypeListSearchMeta {
  /** Types of the search: the pager's total. */
  total: number;
  /** Vehicles registered with one of them (the sum of the "Veículos" column). */
  vehicles: number;
  /** Types no vehicle uses: the only ones that can be deleted. */
  withoutVehicles: number;
  /** The type most vehicles have; null while no vehicle has a type. */
  mostUsed: CatalogLeader | null;
}

/** Folds the vehicle count of each type of the search (the repository's `usage`). */
function summarizeVehicleTypeList(
  usage: ReadonlyArray<CatalogUsage>,
): VehicleTypeListSearchMeta {
  const { total, linked, unused, leader } = summarizeCatalogUsage(usage);

  return { total, vehicles: linked, withoutVehicles: unused, mostUsed: leader };
}

export {
  summarizeVehicleTypeList,
  VEHICLE_TYPE_SORT,
  VEHICLE_TYPE_SORT_FALLBACK,
  VEHICLE_TYPE_SORT_KEYS,
  vehicleTypeListWhere,
};
export type { VehicleTypeListFilters, VehicleTypeListSearchMeta, VehicleTypeSortKey };
