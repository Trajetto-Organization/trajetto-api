import type { Prisma, QuoteStatus } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The quotes list's server-side table (decision 8.8). The /admin screen
 * counted "Pendentes", "Contatados" and "Convertidos" on the ten rows of the
 * page and filtered status, company and fleet size among those rows.
 */

/** The pipeline, in the order the enum declares it (and Postgres sorts it). */
const QUOTE_STATUSES = ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"] as const;

/** What the public form offers (create-quote-schema). */
const QUOTE_FLEET_SIZES = [
  "1-5",
  "6-15",
  "16-30",
  "31-50",
  "51-100",
  "101+",
] as const;

type QuoteFleetSize = (typeof QUOTE_FLEET_SIZES)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const QUOTE_SORT_KEYS = [
  "created_at",
  "updated_at",
  "name",
  "company",
  "email",
  "status",
  "contacted_at",
] as const;

type QuoteSortKey = (typeof QUOTE_SORT_KEYS)[number];

const QUOTE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const QUOTE_SORT: SortSpec<QuoteSortKey, Prisma.QuoteOrderByWithRelationInput> =
  {
    keys: QUOTE_SORT_KEYS,
    fallback: QUOTE_SORT_FALLBACK,
    columns: {
      created_at: (order: SortOrder) => ({ created_at: order }),
      updated_at: (order: SortOrder) => ({ updated_at: order }),
      name: (order: SortOrder) => ({ name: order }),
      company: (order: SortOrder) => ({ company: order }),
      email: (order: SortOrder) => ({ email: order }),
      // By the pipeline's order (the enum's), not alphabetically.
      status: (order: SortOrder) => ({ status: order }),
      // Never contacted: last either way.
      contacted_at: (order: SortOrder) => ({
        contacted_at: { sort: order, nulls: "last" },
      }),
    },
    // Newest first inside a tie; the id breaks what created_at cannot.
    tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
  };

interface QuoteListFilters {
  search?: string;
  statuses?: QuoteStatus[];
  fleetSizes?: QuoteFleetSize[];
}

/**
 * The list's `where`. `except` drops one facet (or both), for the breakdown
 * that facet is counted over (the disjunctive rule).
 */
function quoteListWhere(
  filters: QuoteListFilters,
  { except }: { except?: "status" | "fleet_size" | "facets" } = {},
): Prisma.QuoteWhereInput {
  const and: Prisma.QuoteWhereInput[] = [];

  if (except !== "status" && except !== "facets" && filters.statuses?.length) {
    and.push({ status: { in: filters.statuses } });
  }

  if (
    except !== "fleet_size" &&
    except !== "facets" &&
    filters.fleetSizes?.length
  ) {
    and.push({ fleet_size: { in: filters.fleetSizes } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const digits = term.replace(/\D/g, "");
    const phoneDigits =
      digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;

    and.push(
      buildSearchOr<Prisma.QuoteWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        { company: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { fleet_size: { contains: term, mode: "insensitive" } },
        { message: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
        ...(digits ? [{ telephone: { contains: phoneDigits } }] : []),
      ]),
    );
  }

  return and.length > 0 ? { AND: and } : {};
}

/** Quotes per (status, fleet_size) over the base: search applied, facets not. */
interface QuoteGroupCount {
  status: QuoteStatus;
  fleet_size: string;
  count: number;
}

interface QuoteListSearchMeta {
  /** The total card: every filter applied. */
  total: number;
  /**
   * The per-stage cards, a breakdown by the status facet: the search and the
   * fleet-size filter apply, the status one does not (picking "Pendente"
   * narrows the table without zeroing "Contatados").
   */
  pending: number;
  contacted: number;
  closed: number;
  converted: number;
  facets: { status: FacetCount[]; fleet_size: FacetCount[] };
}

/**
 * The pager total, the cards and both facets' options from one GROUP BY
 * (status, fleet_size) over the base. Exact because both facets are
 * functions of the row's own columns.
 */
function summarizeQuoteList(
  groups: QuoteGroupCount[],
  filters: Pick<QuoteListFilters, "statuses" | "fleetSizes">,
): { total: number; searchMeta: QuoteListSearchMeta } {
  const statusFilter = filters.statuses?.length
    ? new Set<string>(filters.statuses)
    : null;
  const fleetFilter = filters.fleetSizes?.length
    ? new Set<string>(filters.fleetSizes)
    : null;

  const matchesStatus = (group: QuoteGroupCount) =>
    !statusFilter || statusFilter.has(group.status);
  const matchesFleet = (group: QuoteGroupCount) =>
    !fleetFilter || fleetFilter.has(group.fleet_size);

  const total = sumCounts(
    groups.filter((group) => matchesStatus(group) && matchesFleet(group)),
  );

  // Each facet (and the per-stage cards) with the OTHER filter applied.
  const forStatus = groups.filter(matchesFleet);
  const byStatus = (status: QuoteStatus) =>
    sumCounts(forStatus.filter((group) => group.status === status));

  const forFleet = groups.filter(matchesStatus);

  return {
    total,
    searchMeta: {
      total,
      pending: byStatus("PENDING"),
      contacted: byStatus("CONTACTED"),
      closed: byStatus("CLOSED"),
      converted: byStatus("CONVERTED"),
      facets: {
        status: QUOTE_STATUSES.map((status) => ({
          value: status,
          count: byStatus(status),
        })),
        fleet_size: QUOTE_FLEET_SIZES.map((size) => ({
          value: size,
          count: sumCounts(
            forFleet.filter((group) => group.fleet_size === size),
          ),
        })),
      },
    },
  };
}

export {
  QUOTE_FLEET_SIZES,
  QUOTE_SORT,
  QUOTE_SORT_FALLBACK,
  QUOTE_SORT_KEYS,
  QUOTE_STATUSES,
  quoteListWhere,
  summarizeQuoteList,
  type QuoteFleetSize,
  type QuoteGroupCount,
  type QuoteListFilters,
  type QuoteListSearchMeta,
  type QuoteSortKey,
};
