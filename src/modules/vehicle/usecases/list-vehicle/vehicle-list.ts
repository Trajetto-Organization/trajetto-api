import type { Prisma } from "@prisma/client";

import { idSearchConditions } from "@/shared/pagination/id-search";
import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

import {
  VEHICLE_STATUSES,
  type VehicleStatus,
} from "@/shared/vehicle/vehicle-rules";

import type { VehicleStatusCounts } from "../../dtos/vehicle-dto";

/**
 * The vehicle listing's server-side table (decision 8.8): what it sorts by,
 * what it filters by and how the cards and filter counts are derived. The
 * export reads the same `where` (decision 5.8).
 */

/** Same ids as the web table's columns, so the URL value is the column id. */
const VEHICLE_SORT_KEYS = [
  "created_at",
  "description",
  "license_plate",
  "brand",
  "model",
  "status",
  "current_mileage",
  "acquisition_date",
  "model_year",
  "last_maintenance_date",
  "vehicleTypeDescription",
  "driverName",
  "branchName",
] as const;

type VehicleSortKey = (typeof VEHICLE_SORT_KEYS)[number];

const VEHICLE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.VehicleOrderByWithRelationInput;

const VEHICLE_SORT: SortSpec<VehicleSortKey, OrderBy> = {
  keys: VEHICLE_SORT_KEYS,
  fallback: VEHICLE_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    description: (order: SortOrder) => ({ description: order }),
    license_plate: (order: SortOrder) => ({ license_plate: order }),
    brand: (order: SortOrder) => ({ brand: order }),
    model: (order: SortOrder) => ({ model: order }),
    status: (order: SortOrder) => ({ status: order }),
    current_mileage: (order: SortOrder) => ({ current_mileage: order }),
    acquisition_date: (order: SortOrder) => ({ acquisition_date: order }),
    model_year: (order: SortOrder) => ({ model_year: order }),
    last_maintenance_date: (order: SortOrder) => ({
      last_maintenance_date: order,
    }),
    vehicleTypeDescription: (order: SortOrder) => ({
      vehicleType: { description: order },
    }),
    driverName: (order: SortOrder) => ({ driver: { name: order } }),
    branchName: (order: SortOrder) => ({ branch: { corporate_reason: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface VehicleListFilters {
  businessId: string;
  search?: string;
  statuses?: VehicleStatus[];
  branchIds?: string[];
}

type VehicleFacet = "status" | "branch";

/**
 * The listing's `where`, optionally without one facet: a number broken down
 * by a facet is counted with every OTHER filter applied (the disjunctive rule
 * of shared/pagination/list-meta).
 */
function vehicleListWhere(
  filters: VehicleListFilters,
  { except }: { except?: VehicleFacet } = {},
): Prisma.VehicleWhereInput {
  const and: Prisma.VehicleWhereInput[] = [];

  if (except !== "status" && filters.statuses?.length) {
    and.push({ status: { in: filters.statuses } });
  }

  if (except !== "branch" && filters.branchIds?.length) {
    and.push({ branchId: { in: filters.branchIds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.VehicleWhereInput>([
        // The id the table shows (its tail) or the row menu copies (whole)
        // finds the row: equality for a whole UUID, `endsWith` for a tail,
        // nothing for any other term (shared/pagination/id-search).
        ...idSearchConditions(term),
        { description: { contains: term, mode: "insensitive" } },
        { license_plate: { contains: term, mode: "insensitive" } },
        { brand: { contains: term, mode: "insensitive" } },
        { model: { contains: term, mode: "insensitive" } },
        { renavam: { contains: term, mode: "insensitive" } },
        { fleet_id: { contains: term, mode: "insensitive" } },
        { driver: { name: { contains: term, mode: "insensitive" } } },
        {
          vehicleType: { description: { contains: term, mode: "insensitive" } },
        },
        {
          branch: { corporate_reason: { contains: term, mode: "insensitive" } },
        },
      ]),
    );
  }

  // The tenant stays a top-level key: (businessId, created_at) serves it.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Vehicles per branch over every filter but the branch one. */
interface VehicleBranchCount {
  id: string;
  name: string;
  count: number;
}

interface VehicleListSearchMeta {
  /** Cards: every filter except status, so the four always add up. */
  total: number;
  statusCounts: VehicleStatusCounts;
  facets: {
    status: FacetCount[];
    branchId: FacetCount[];
  };
}

/**
 * The pager total, the cards and the filter options.
 *
 * `statusCounts` was grouped without the status facet, so the pager total is
 * the part of it the selected statuses keep; the cards show the whole of it.
 */
function summarizeVehicleList(
  statusCounts: VehicleStatusCounts,
  branchCounts: VehicleBranchCount[],
  filters: Pick<VehicleListFilters, "statuses">,
): { total: number; searchMeta: VehicleListSearchMeta } {
  const selected = filters.statuses?.length
    ? new Set<VehicleStatus>(filters.statuses)
    : undefined;

  const cardTotal = VEHICLE_STATUSES.reduce(
    (sum, status) => sum + statusCounts[status],
    0,
  );

  const total = selected
    ? VEHICLE_STATUSES.filter((status) => selected.has(status)).reduce(
        (sum, status) => sum + statusCounts[status],
        0,
      )
    : cardTotal;

  // The repository already added the selected branches of this company that
  // matched nothing (count 0); an id of another company never gets a name.
  const branchOptions: FacetCount[] = branchCounts
    .map((branch) => ({
      value: branch.id,
      label: branch.name,
      count: branch.count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

  return {
    total,
    searchMeta: {
      total: cardTotal,
      statusCounts,
      facets: {
        status: VEHICLE_STATUSES.map((status) => ({
          value: status,
          count: statusCounts[status],
        })),
        branchId: branchOptions,
      },
    },
  };
}

export {
  VEHICLE_SORT,
  VEHICLE_SORT_FALLBACK,
  VEHICLE_SORT_KEYS,
  summarizeVehicleList,
  vehicleListWhere,
};
export type {
  VehicleBranchCount,
  VehicleFacet,
  VehicleListFilters,
  VehicleListSearchMeta,
  VehicleSortKey,
};
