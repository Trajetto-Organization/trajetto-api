import { Decimal } from "@prisma/client/runtime/client";

import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  PartSortKey,
  PartSupplierCount,
} from "../usecases/list-part/part-list";

interface Part {
  id: string;
  description: string;
  unit_price: Decimal | string;
  businessId?: string | null;
  supplierId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  supplier?: {
    name: string;
  } | null;
  business?: {
    corporate_reason: string;
  } | null;
}

interface CreatePartProps {
  description: string;
  unit_price: number;
  businessId: string;
  supplierId?: string | null;
}

interface UpdatePartProps {
  description?: string;
  unit_price?: number;
  supplierId?: string | null;
  businessId?: string;
}

interface UpdatePart {
  partData: UpdatePartProps;
  partId: string;
}

/** A listed part: the row plus how many order lines use it. */
interface PartListRow extends Part {
  /** Lines of service orders that use it: a used part cannot be deleted. */
  service_order_parts_count: number;
}

/** What the repository answers; the use case turns the counts into searchMeta. */
interface ListPartProps {
  data: PartListRow[];
  /** Parts per supplier over search (no supplier facet), with names. */
  supplierCounts: PartSupplierCount[];
}

interface ListPartByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
  supplierIds?: string[];
  sort?: PartSortKey;
  order?: SortOrder;
}

interface SearchPartWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  /** The picker's typed term (FLEET-SEARCH-1). */
  search?: string;
}

interface CursorPaginatedPart {
  data: Part[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  Part,
  PartListRow,
  CreatePartProps,
  UpdatePart,
  ListPartProps,
  ListPartByBusinessIdProps,
  UpdatePartProps,
  SearchPartWithCursorProps,
  CursorPaginatedPart,
};
