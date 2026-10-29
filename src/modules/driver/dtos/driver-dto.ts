import type {
  CnhCategory,
  CnhCategoryFacet,
  DriverContractType,
  DriverGroupCount,
  DriverSortKey,
  DriverStatus,
} from "../usecases/list-driver/driver-list";

import type { SortOrder } from "@/shared/pagination/list-query";

interface Driver {
  id: string;
  name: string;
  birth_date: Date | string;
  cnh: string;
  cpf: string;
  /** Licence class and expiry (decision 8.5); null on legacy rows. */
  cnh_category?: CnhCategory | null;
  /** A civil date (`@db.Date`): UTC midnight of the expiry day. */
  cnh_expires_at?: Date | null;
  rg: string;
  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string;
  complement?: string | null;
  status: DriverStatus;
  contract_type: DriverContractType;
  businessId: string;
  branchId?: string | null;
  branch?: {
    is_active?: boolean;
    corporate_reason?: string;
  } | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateDriverProps {
  name: string;
  birth_date: Date | string;
  cnh: string;
  cpf: string;
  cnh_category?: CnhCategory | null;
  cnh_expires_at?: Date | null;
  rg: string;
  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string;
  complement?: string | null;
  status: DriverStatus;
  contract_type: DriverContractType;
  businessId: string;
  branchId?: string | null;
}

interface UpdateDriverProps {
  name?: string;
  birth_date?: Date | string;
  cnh?: string;
  cpf?: string;
  cnh_category?: CnhCategory | null;
  cnh_expires_at?: Date | null;
  rg?: string;
  cep?: string;
  city?: string;
  uf?: string;
  street?: string;
  address_number?: string;
  complement?: string | null;
  status?: DriverStatus;
  contract_type?: DriverContractType;
  businessId?: string;
  branchId?: string | null;
}

interface UpdateDriver {
  driverData: UpdateDriverProps;
  driverId: string;
}

/** One company's list, filtered, sorted and paged by the server (decision 8.8). */
interface ListDriversProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
  sort?: DriverSortKey;
  order?: SortOrder;
  statuses?: DriverStatus[];
  contractTypes?: DriverContractType[];
  cnhCategories?: CnhCategoryFacet[];
  branchIds?: string[];
}

type DriverListRow = Driver & {
  branch: { corporate_reason: string } | null;
};

interface ListDriversResult {
  data: DriverListRow[];
  /** Counts per faceted combination over the base (search, no facets). */
  groups: DriverGroupCount[];
  /** Names of this company's branches the facet may offer. */
  branchNames: Map<string, string>;
}

/** The export's filter: the list's, without paging. */
type DriverExportFilters = Omit<ListDriversProps, "page" | "pageSize">;

interface SearchDriverWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  search?: string;
  /**
   * `choice` is what a dispatcher without the driver catalogue may see
   * (decision 4.7): enough to pick someone, and the licence facts the
   * assignment warns about — never the documents.
   */
  projection?: "catalog" | "choice";
}

interface DriverChoiceItem {
  id: string;
  name: string;
  status: DriverStatus;
  cnh_category: CnhCategory | null;
  cnh_expires_at: Date | null;
}

interface DriverCursorItem extends DriverChoiceItem {
  cnh: string;
  branchId: string | null;
  businessId: string;
  created_at: Date | string;
}

interface CursorPaginatedDriver {
  data: Array<DriverCursorItem | DriverChoiceItem>;
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  Driver,
  CreateDriverProps,
  UpdateDriver,
  UpdateDriverProps,
  ListDriversProps,
  ListDriversResult,
  DriverListRow,
  DriverExportFilters,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
  DriverCursorItem,
  DriverChoiceItem,
};
