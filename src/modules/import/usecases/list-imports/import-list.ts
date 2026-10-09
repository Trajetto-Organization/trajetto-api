import type { Prisma } from "@prisma/client";

import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

import { disjunctiveFacets } from "@/shared/delivery/catalog-list";

import type { ImportSource, ImportStatus } from "../../dtos/import-dto";

/**
 * The Importações table on the server (decision 8.8): its order and its
 * Status/Origem filters, over the whole company.
 */

const IMPORT_STATUSES = [
  "IN_PROGRESS",
  "COMPLETED",
  "REVERSED",
] as const satisfies readonly ImportStatus[];

const IMPORT_SOURCES = [
  "SPREADSHEET",
  "NFE_XML",
] as const satisfies readonly ImportSource[];

/** Same ids as the web table's columns: the URL value is the column id. */
const IMPORT_SORT_KEYS = [
  "created_at",
  "filename",
  "imported",
  "duplicated",
  "invalid",
] as const;

type ImportSortKey = (typeof IMPORT_SORT_KEYS)[number];

const IMPORT_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const IMPORT_SORT: SortSpec<ImportSortKey, Prisma.ImportOrderByWithRelationInput> =
  {
    keys: IMPORT_SORT_KEYS,
    fallback: IMPORT_SORT_FALLBACK,
    columns: {
      created_at: (order: SortOrder) => ({ created_at: order }),
      filename: (order: SortOrder) => ({ filename: order }),
      imported: (order: SortOrder) => ({ imported: order }),
      duplicated: (order: SortOrder) => ({ duplicated: order }),
      invalid: (order: SortOrder) => ({ invalid: order }),
    },
    tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
  };

interface ImportListFilters {
  businessId: string;
  statuses?: ImportStatus[];
  sources?: ImportSource[];
}

/** The listing's `where`; without facets, the base the counts group over. */
function importListWhere(
  filters: ImportListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.ImportWhereInput {
  const and: Prisma.ImportWhereInput[] = [];

  if (withFacets && filters.statuses?.length) {
    and.push({ status: { in: filters.statuses } });
  }

  if (withFacets && filters.sources?.length) {
    and.push({ source: { in: filters.sources } });
  }

  // The tenant stays a top-level key: the (businessId, created_at) index.
  return { businessId: filters.businessId, ...(and.length > 0 && { AND: and }) };
}

/** Uploads per status and origin, over the company. */
interface ImportGroup {
  status: ImportStatus;
  source: ImportSource;
  count: number;
}

interface ImportListSearchMeta {
  facets: { status: FacetCount[]; source: FacetCount[] };
}

function summarizeImportList(
  groups: ReadonlyArray<ImportGroup>,
  filters: Pick<ImportListFilters, "statuses" | "sources">,
): { total: number; searchMeta: ImportListSearchMeta } {
  const { total, facets } = disjunctiveFacets(
    groups.map((group) => ({
      values: { status: group.status, source: group.source },
      count: group.count,
    })),
    { status: filters.statuses, source: filters.sources },
    { status: IMPORT_STATUSES, source: IMPORT_SOURCES },
  );

  return { total, searchMeta: { facets } };
}

export {
  IMPORT_SORT,
  IMPORT_SORT_FALLBACK,
  IMPORT_SORT_KEYS,
  IMPORT_SOURCES,
  IMPORT_STATUSES,
  importListWhere,
  summarizeImportList,
  type ImportGroup,
  type ImportListFilters,
  type ImportListSearchMeta,
  type ImportSortKey,
};
