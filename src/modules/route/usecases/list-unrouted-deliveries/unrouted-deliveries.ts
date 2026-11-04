import type { Prisma } from "@prisma/client";

import { AppError } from "@/shared/errors/AppError";
import { buildSearchOr } from "@/shared/pagination/search-or";
import { OPEN_STOP_STATUSES } from "@/shared/route/route-rules";
import type { DeliveryKind } from "@/shared/delivery/delivery-kind";

/**
 * "Without a route" (decision 14.7, D3): PENDING and no open stop anywhere.
 *
 * The same predicate as the partial unique index `route_stop_active_delivery_idx`
 * (status IN PENDING/ARRIVED), so the picker offers exactly the deliveries the
 * database would accept on a new stop. A FAILED delivery only comes back after
 * the re-delivery decision moves it to PENDING, as today.
 */
type UnroutedFacet = "city" | "uf" | "kind" | "shipper";

/**
 * Where a picker page ended (plan of 02/11/2026, G9): the last row's place
 * in the list's order — scheduled day (no day last), creation, id.
 */
interface UnroutedKey {
  scheduled_date: Date | null;
  created_at: Date;
  id: string;
}

interface UnroutedDeliveriesQuery {
  businessId: string;

  /** Offset paging, kept for the web still in the field; ignored with `after`. */
  page: number;
  pageSize: number;

  /**
   * The keyset: the rows after this one (G9). A picker that scrolls while
   * colleagues route deliveries away neither repeats nor skips a row, which
   * an offset did. Pages after the first skip the counts.
   */
  after?: UnroutedKey;

  /** Code, NF number, NF-e key, recipient or city. */
  search?: string;

  shipperIds?: string[];
  cities?: string[];
  ufs?: string[];
  kinds?: DeliveryKind[];

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

  /** Only on a first page (no `after`): later pages keep the first one's. */
  total?: number;
  facets?: {
    city: FacetCount[];
    uf: FacetCount[];
    kind: FacetCount[];
    shipper: LabelledFacetCount[];
  };

  /** The cursor of the next page; null at the end of the list. */
  nextCursor: string | null;
}

/** The list's order, the keyset's: scheduled day with no day last, creation, id. */
const UNROUTED_ORDER = [
  { scheduled_date: { sort: "asc", nulls: "last" } },
  { created_at: "asc" },
  { id: "asc" },
] as const;

const INVALID_CURSOR = () =>
  new AppError(
    "Cursor inválido. Recarregue a lista e tente de novo.",
    400,
    "INVALID_CURSOR",
  );

/** An opaque cursor: the key, as base64url JSON. */
function encodeUnroutedCursor(key: UnroutedKey): string {
  return Buffer.from(
    JSON.stringify({
      s: key.scheduled_date ? key.scheduled_date.toISOString() : null,
      c: key.created_at.toISOString(),
      i: key.id,
    }),
  ).toString("base64url");
}

function decodeUnroutedCursor(cursor: string): UnroutedKey {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw INVALID_CURSOR();
  }

  const { s, c, i } = (parsed ?? {}) as Record<string, unknown>;

  const instant = (value: unknown): Date | null => {
    if (typeof value !== "string") return null;

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
  };

  const created = instant(c);
  const scheduled = s === null ? null : instant(s);

  if (
    !created ||
    (s !== null && !scheduled) ||
    typeof i !== "string" ||
    i.length === 0 ||
    i.length > 64
  ) {
    throw INVALID_CURSOR();
  }

  return { scheduled_date: scheduled, created_at: created, id: i };
}

/**
 * The rows after `after` in UNROUTED_ORDER. Inside the caller's tenant
 * `where`: a forged cursor moves the start of a company's own list, never
 * into another company's.
 */
function unroutedKeysetAfter(after: UnroutedKey): Prisma.DeliveryWhereInput {
  const later: Prisma.DeliveryWhereInput = {
    OR: [
      { created_at: { gt: after.created_at } },
      { created_at: after.created_at, id: { gt: after.id } },
    ],
  };

  if (after.scheduled_date === null) {
    return { AND: [{ scheduled_date: null }, later] };
  }

  return {
    OR: [
      { scheduled_date: { gt: after.scheduled_date } },
      { AND: [{ scheduled_date: after.scheduled_date }, later] },
      { scheduled_date: null },
    ],
  };
}

/** Same order as UNROUTED_ORDER, for the twin. */
function compareUnroutedKeys(a: UnroutedKey, b: UnroutedKey): number {
  const da = a.scheduled_date?.getTime() ?? null;
  const db = b.scheduled_date?.getTime() ?? null;

  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;

    return da - db;
  }

  const byCreation = a.created_at.getTime() - b.created_at.getTime();

  if (byCreation !== 0) return byCreation;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  UNROUTED_ORDER,
  compareUnroutedKeys,
  decodeUnroutedCursor,
  encodeUnroutedCursor,
  orderShipperFacet,
  unroutedDeliveriesWhere,
  unroutedKeysetAfter,
};
export type {
  FacetCount,
  LabelledFacetCount,
  UnroutedDeliveriesPage,
  UnroutedDeliveriesQuery,
  UnroutedDeliveryRow,
  UnroutedFacet,
  UnroutedKey,
};
