import { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";
import { escapeLikePattern } from "@/shared/utils/like-pattern";

/**
 * The service order parts listing's server-side table (decision 8.8). The
 * cards (value with discounts, lines with a discount, mean value) were sums
 * over the ten rows on screen; they are an aggregate over the company now.
 */

/** Same ids as the web table's columns. */
const SERVICE_ORDER_PART_SORT_KEYS = [
  "created_at",
  "updated_at",
  "partDescription",
  "unit_price",
  "quantity",
  "discount_percentage",
  "serviceOrderDate",
  "vehicleLicensePlate",
] as const;

type ServiceOrderPartSortKey = (typeof SERVICE_ORDER_PART_SORT_KEYS)[number];

const SERVICE_ORDER_PART_SORT_FALLBACK = {
  sort: "created_at",
  order: "desc",
} as const;

const SERVICE_ORDER_PART_SORT: SortSpec<
  ServiceOrderPartSortKey,
  Prisma.ServiceOrderPartOrderByWithRelationInput
> = {
  keys: SERVICE_ORDER_PART_SORT_KEYS,
  fallback: SERVICE_ORDER_PART_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    partDescription: (order: SortOrder) => ({ part: { description: order } }),
    unit_price: (order: SortOrder) => ({ unit_price: order }),
    quantity: (order: SortOrder) => ({ quantity: order }),
    discount_percentage: (order: SortOrder) => ({ discount_percentage: order }),
    serviceOrderDate: (order: SortOrder) => ({ serviceOrder: { date: order } }),
    vehicleLicensePlate: (order: SortOrder) => ({
      serviceOrder: { vehicle: { license_plate: order } },
    }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface ServiceOrderPartListFilters {
  businessId: string;
  search?: string;
  partIds?: string[];
  /** One order's lines (the order's "Ver peças"); a filter without counts. */
  serviceOrderIds?: string[];
}

/**
 * The listing's `where` for Prisma. Mirrored clause by clause by
 * serviceOrderPartListSql below, which the cards are summed over: the two
 * must keep matching the same rows (tests/E2E pins it).
 */
function serviceOrderPartListWhere(
  filters: ServiceOrderPartListFilters,
  { except }: { except?: "part" } = {},
): Prisma.ServiceOrderPartWhereInput {
  const and: Prisma.ServiceOrderPartWhereInput[] = [];

  if (except !== "part" && filters.partIds?.length) {
    and.push({ partId: { in: filters.partIds } });
  }

  if (filters.serviceOrderIds?.length) {
    and.push({ serviceOrderId: { in: filters.serviceOrderIds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.ServiceOrderPartWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { serviceOrderId: { contains: term, mode: "insensitive" } },
        { part: { description: { contains: term, mode: "insensitive" } } },
        {
          serviceOrder: {
            vehicle: { license_plate: { contains: term, mode: "insensitive" } },
          },
        },
      ]),
    );
  }

  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/**
 * The same rows as serviceOrderPartListWhere, as SQL over
 * service_order_part sop JOIN part p JOIN service_order so JOIN vehicle v.
 * ILIKE with the same escaping Prisma's `contains` gets from buildSearchOr.
 */
function serviceOrderPartListSql(
  filters: ServiceOrderPartListFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`sop."businessId" = ${filters.businessId}`,
  ];

  if (filters.partIds?.length) {
    clauses.push(Prisma.sql`sop."partId" IN (${Prisma.join(filters.partIds)})`);
  }

  if (filters.serviceOrderIds?.length) {
    clauses.push(
      Prisma.sql`sop."serviceOrderId" IN (${Prisma.join(filters.serviceOrderIds)})`,
    );
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const pattern = `%${escapeLikePattern(term)}%`;

    clauses.push(Prisma.sql`(
      sop."id" ILIKE ${pattern}
      OR sop."serviceOrderId" ILIKE ${pattern}
      OR p."description" ILIKE ${pattern}
      OR v."license_plate" ILIKE ${pattern}
    )`);
  }

  return Prisma.join(clauses, " AND ");
}

interface ServiceOrderPartAggregate {
  count: number;
  withDiscount: number;
  totalValue: number;
}

interface ServiceOrderPartListSearchMeta {
  /** Cards, over every filter: the lines the table shows. */
  total: number;
  withDiscount: number;
  /** Σ unit price × quantity − discount, in reais. */
  totalValue: number;
  /** totalValue / total, rounded to cents. */
  averageValue: number;
  facets: { partId: FacetCount[] };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizeServiceOrderPartList(
  aggregate: ServiceOrderPartAggregate,
  partCounts: FacetCount[],
): { total: number; searchMeta: ServiceOrderPartListSearchMeta } {
  return {
    total: aggregate.count,
    searchMeta: {
      total: aggregate.count,
      withDiscount: aggregate.withDiscount,
      totalValue: round2(aggregate.totalValue),
      averageValue:
        aggregate.count > 0
          ? round2(aggregate.totalValue / aggregate.count)
          : 0,
      facets: {
        partId: [...partCounts].sort((a, b) =>
          (a.label ?? "").localeCompare(b.label ?? "", "pt-BR"),
        ),
      },
    },
  };
}

export {
  SERVICE_ORDER_PART_SORT,
  SERVICE_ORDER_PART_SORT_FALLBACK,
  SERVICE_ORDER_PART_SORT_KEYS,
  serviceOrderPartListSql,
  serviceOrderPartListWhere,
  summarizeServiceOrderPartList,
  type ServiceOrderPartAggregate,
  type ServiceOrderPartListFilters,
  type ServiceOrderPartListSearchMeta,
  type ServiceOrderPartSortKey,
};
