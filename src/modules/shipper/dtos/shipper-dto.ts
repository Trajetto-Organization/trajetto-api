import type { SortOrder } from "@/shared/pagination/list-query";
import type { ActiveStatus } from "@/shared/delivery/catalog-list";
import type {
  ShipperGroup,
  ShipperListSearchMeta,
  ShipperSortKey,
} from "../usecases/list-shipper/shipper-list";

interface Shipper {
  id?: string;
  name: string;
  /** Legal name for the proof document (decision 14.8); null = use name. */
  corporate_reason?: string | null;
  cnpj?: string | null;
  email?: string | null;
  telephone?: string | null;
  is_active?: boolean;
  businessId: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface CreateShipperProps {
  name: string;
  corporate_reason?: string | null;
  cnpj?: string | null;
  email?: string | null;
  telephone?: string | null;
  businessId: string;
}

interface UpdateShipperProps {
  name?: string | null;
  corporate_reason?: string | null;
  cnpj?: string | null;
  email?: string | null;
  telephone?: string | null;
  is_active?: boolean;
}

interface ListShippersProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
  sort?: ShipperSortKey;
  order?: SortOrder;
  /** The Status filter; none or both keeps every shipper. */
  statuses?: ActiveStatus[];
}

/** The page and the per-status counts the cards and the filter are built from. */
interface ListShippersPage {
  data: Shipper[];
  groups: ShipperGroup[];
}

interface SearchShipperWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  /** The picker's typed term: name, CNPJ or e-mail. */
  search?: string;
}

interface CursorPaginatedShipper {
  data: Shipper[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ListShippersResult {
  data: Shipper[];
  total: number;
  /** Rides along in the NDJSON meta line: the cards and the filter counts. */
  meta: ShipperListSearchMeta;
}

export {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersPage,
  ListShippersResult,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
};
