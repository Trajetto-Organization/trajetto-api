import type { Prisma } from "@prisma/client";

import { idSearchConditions } from "@/shared/pagination/id-search";
import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The checklist listing's server-side table (decision 8.8): order, facets
 * and the cards by overall condition. The export reads the same `where`.
 */

const CHECKLIST_CONDITIONS = [
  "approved",
  "approved_with_restrictions",
  "rejected",
] as const;

type ChecklistCondition = (typeof CHECKLIST_CONDITIONS)[number];

/** Same ids as the web table's columns. */
const CHECKLIST_SORT_KEYS = [
  "created_at",
  "checklist_date",
  "current_mileage",
  "overall_condition",
  "vehicle_license_plate",
  "vehicle_description",
  "driver_name",
  "branchName",
] as const;

type ChecklistSortKey = (typeof CHECKLIST_SORT_KEYS)[number];

const CHECKLIST_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.VehicleChecklistOrderByWithRelationInput;

const CHECKLIST_SORT: SortSpec<ChecklistSortKey, OrderBy> = {
  keys: CHECKLIST_SORT_KEYS,
  fallback: CHECKLIST_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    checklist_date: (order: SortOrder) => ({ checklist_date: order }),
    current_mileage: (order: SortOrder) => ({ current_mileage: order }),
    overall_condition: (order: SortOrder) => ({ overall_condition: order }),
    vehicle_license_plate: (order: SortOrder) => ({
      vehicle: { license_plate: order },
    }),
    vehicle_description: (order: SortOrder) => ({
      vehicle: { description: order },
    }),
    driver_name: (order: SortOrder) => ({ driver: { name: order } }),
    branchName: (order: SortOrder) => ({ branch: { corporate_reason: order } }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface ChecklistListFilters {
  businessId: string;
  /** Driver tokens: only their own checklists (decision 4.4). */
  driverId?: string;
  search?: string;
  conditions?: ChecklistCondition[];
  branchIds?: string[];
  vehicleIds?: string[];
}

type ChecklistFacet = "condition" | "branch" | "vehicle";

/** The listing's `where`, optionally without one facet (disjunctive counts). */
function checklistListWhere(
  filters: ChecklistListFilters,
  { except }: { except?: ChecklistFacet } = {},
): Prisma.VehicleChecklistWhereInput {
  const and: Prisma.VehicleChecklistWhereInput[] = [];

  if (filters.driverId) and.push({ driverId: filters.driverId });

  if (except !== "condition" && filters.conditions?.length) {
    and.push({ overall_condition: { in: filters.conditions } });
  }

  if (except !== "branch" && filters.branchIds?.length) {
    and.push({ branchId: { in: filters.branchIds } });
  }

  if (except !== "vehicle" && filters.vehicleIds?.length) {
    and.push({ vehicleId: { in: filters.vehicleIds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.VehicleChecklistWhereInput>([
        // The id shown (tail) or copied (whole): shared/pagination/id-search.
        ...idSearchConditions(term),
        { notes: { contains: term, mode: "insensitive" } },
        { vehicle: { description: { contains: term, mode: "insensitive" } } },
        { vehicle: { license_plate: { contains: term, mode: "insensitive" } } },
        { vehicle: { brand: { contains: term, mode: "insensitive" } } },
        { vehicle: { model: { contains: term, mode: "insensitive" } } },
        { driver: { name: { contains: term, mode: "insensitive" } } },
        {
          branch: { corporate_reason: { contains: term, mode: "insensitive" } },
        },
        { branch: { fantasy_name: { contains: term, mode: "insensitive" } } },
      ]),
    );
  }

  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

type ConditionCounts = Record<ChecklistCondition, number>;

interface NamedCount {
  id: string;
  name: string;
  count: number;
}

interface ChecklistListSearchMeta {
  /** Cards: every filter but the condition one. */
  total: number;
  approved: number;
  approvedWithRestrictions: number;
  rejected: number;
  facets: {
    overall_condition: FacetCount[];
    branchId: FacetCount[];
    vehicleId: FacetCount[];
  };
}

function toOptions(counts: NamedCount[]): FacetCount[] {
  return counts
    .map((entry) => ({
      value: entry.id,
      label: entry.name,
      count: entry.count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/**
 * The pager total, the cards and the filter options. The condition counts
 * were grouped without the condition facet, so the pager total is the part
 * the selected conditions keep.
 */
function summarizeChecklistList(
  conditionCounts: ConditionCounts,
  branchCounts: NamedCount[],
  vehicleCounts: NamedCount[],
  filters: Pick<ChecklistListFilters, "conditions">,
): { total: number; searchMeta: ChecklistListSearchMeta } {
  const selected = filters.conditions?.length
    ? new Set<ChecklistCondition>(filters.conditions)
    : undefined;

  const cardTotal = CHECKLIST_CONDITIONS.reduce(
    (sum, condition) => sum + conditionCounts[condition],
    0,
  );

  const total = selected
    ? CHECKLIST_CONDITIONS.filter((condition) =>
        selected.has(condition),
      ).reduce((sum, condition) => sum + conditionCounts[condition], 0)
    : cardTotal;

  return {
    total,
    searchMeta: {
      total: cardTotal,
      approved: conditionCounts.approved,
      approvedWithRestrictions: conditionCounts.approved_with_restrictions,
      rejected: conditionCounts.rejected,
      facets: {
        overall_condition: CHECKLIST_CONDITIONS.map((condition) => ({
          value: condition,
          count: conditionCounts[condition],
        })),
        branchId: toOptions(branchCounts),
        vehicleId: toOptions(vehicleCounts),
      },
    },
  };
}

/** Fills the conditions a GROUP BY did not return (no row) with zero. */
function tallyConditions(
  groups: Array<{ overall_condition: string; _count: { _all: number } }>,
): ConditionCounts {
  const counts: ConditionCounts = {
    approved: 0,
    approved_with_restrictions: 0,
    rejected: 0,
  };

  for (const group of groups) {
    if (
      (CHECKLIST_CONDITIONS as readonly string[]).includes(
        group.overall_condition,
      )
    ) {
      counts[group.overall_condition as ChecklistCondition] = group._count._all;
    }
  }

  return counts;
}

export {
  CHECKLIST_CONDITIONS,
  CHECKLIST_SORT,
  CHECKLIST_SORT_FALLBACK,
  CHECKLIST_SORT_KEYS,
  checklistListWhere,
  summarizeChecklistList,
  tallyConditions,
};
export type {
  ChecklistCondition,
  ChecklistFacet,
  ChecklistListFilters,
  ChecklistListSearchMeta,
  ChecklistSortKey,
  ConditionCounts,
  NamedCount,
};
