import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { OPEN_STOP_STATUSES } from "@/shared/route/route-rules";

/**
 * "Without a route" (decision 14.7, D3): PENDING and no open stop anywhere.
 *
 * The same predicate as the partial unique index `route_stop_active_delivery_idx`
 * (status IN PENDING/ARRIVED), so the picker offers exactly the deliveries the
 * database would accept on a new stop. A FAILED delivery only comes back after
 * the re-delivery decision moves it to PENDING, as today.
 */
type UnroutedFacet = "city" | "uf" | "kind" | "shipper";

interface UnroutedDeliveriesQuery {
  businessId: string;
  page: number;
  pageSize: number;

  /** Code, NF number, NF-e key, recipient or city. */
  search?: string;

  shipperIds?: string[];
  cities?: string[];
  ufs?: string[];
  kinds?: Array<"DELIVERY" | "PICKUP">;

  /** Civil days (UTC midnight), inclusive. */
  scheduledFrom?: Date;
  scheduledTo?: Date;

  /** With a range: also the deliveries with no scheduled day. */
  includeUnscheduled?: boolean;
}

interface UnroutedDeliveryRow {
  id: string;
  code: string | null;
  kind: string;
  invoice_number: string | null;
  recipient_name: string;
  street: string;
  address_number: string | null;
  neighborhood: string | null;
  city: string;
  uf: string;
  scheduled_date: Date | null;
  latitude: number | null;
  longitude: number | null;
  shipper: { id: string; name: string } | null;
}

interface FacetCount {
  value: string;
  count: number;
}

/** A shipper option: the id filters, the name is what the chip says. */
interface LabelledFacetCount extends FacetCount {
  label: string;
}

interface UnroutedDeliveriesPage {
  data: UnroutedDeliveryRow[];
  total: number;
  facets: {
    city: FacetCount[];
    uf: FacetCount[];
    kind: FacetCount[];
    shipper: LabelledFacetCount[];
  };
}

/**
 * The shipper options in the order both repositories answer them: the
 * busiest first is how the list is cut at the limit, then by name for the
 * eye, then by id so equal names keep a stable order.
 */
function orderShipperFacet(
  counts: Array<{ value: string; count: number }>,
  nameOf: (id: string) => string | undefined,
): LabelledFacetCount[] {
  return counts
    .slice()
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    )
    .slice(0, UNROUTED_FACET_LIMIT)
    .map((entry) => ({ ...entry, label: nameOf(entry.value) ?? entry.value }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, "pt-BR") ||
        (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
}

/** The most cities the filter lists; the search narrows the rest. */
const UNROUTED_FACET_LIMIT = 50;

const UNROUTED_DELIVERY_SELECT = {
  id: true,
  code: true,
  kind: true,
  invoice_number: true,
  recipient_name: true,
  street: true,
  address_number: true,
  neighborhood: true,
  city: true,
  uf: true,
  scheduled_date: true,
  latitude: true,
  longitude: true,
  shipper: { select: { id: true, name: true } },
} as const;

/**
 * The picker's `where`. `skip` leaves out one facet's own filter, so each
 * filter's counts answer "what would I get if I changed THIS one" — the
 * disjunctive rule every server table in the product follows.
 */
function unroutedDeliveriesWhere(
  query: UnroutedDeliveriesQuery,
  skip: UnroutedFacet | null,
): Prisma.DeliveryWhereInput {
  const and: Prisma.DeliveryWhereInput[] = [
    { businessId: query.businessId },
    { status: "PENDING" },

    // The anti-join on the partial unique index (D3).
    { stops: { none: { status: { in: OPEN_STOP_STATUSES } } } },
  ];

  const search = query.search?.trim();

  if (search) {
    // buildSearchOr escapes % and _: "50%" searches for the text, not a
    // wildcard (the LIKE guard in tests/unitaires/security).
    and.push(
      buildSearchOr<Prisma.DeliveryWhereInput>([
        { code: { contains: search, mode: "insensitive" } },
        { invoice_number: { contains: search, mode: "insensitive" } },
        { invoice_key: { contains: search } },
        { recipient_name: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
        { street: { contains: search, mode: "insensitive" } },
      ]),
    );
  }

  if (skip !== "shipper" && query.shipperIds?.length) {
    and.push({ shipperId: { in: query.shipperIds } });
  }

  if (skip !== "city" && query.cities?.length) {
    and.push({
      OR: query.cities.map((city) => ({
        city: { equals: city, mode: "insensitive" as const },
      })),
    });
  }

  if (skip !== "uf" && query.ufs?.length) {
    and.push({ uf: { in: query.ufs.map((uf) => uf.toUpperCase()) } });
  }

  if (skip !== "kind" && query.kinds?.length) {
    and.push({ kind: { in: query.kinds } });
  }

  if (query.scheduledFrom || query.scheduledTo) {
    const range: Prisma.DeliveryWhereInput = {
      scheduled_date: {
        ...(query.scheduledFrom && { gte: query.scheduledFrom }),
        ...(query.scheduledTo && { lte: query.scheduledTo }),
      },
    };

    and.push(
      query.includeUnscheduled
        ? { OR: [range, { scheduled_date: null }] }
        : range,
    );
  } else if (query.includeUnscheduled === false) {
    and.push({ scheduled_date: { not: null } });
  }

  return { AND: and };
}

export {
  UNROUTED_DELIVERY_SELECT,
  UNROUTED_FACET_LIMIT,
  orderShipperFacet,
  unroutedDeliveriesWhere,
};
export type {
  FacetCount,
  LabelledFacetCount,
  UnroutedDeliveriesPage,
  UnroutedDeliveriesQuery,
  UnroutedDeliveryRow,
  UnroutedFacet,
};
