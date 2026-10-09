import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  BrazilianUf,
  SupplierSortKey,
  SupplierStateCount,
} from "../usecases/list-supplier/supplier-list";

interface CreateSupplierProps {
  name: string;
  cnpj: string;
  cep?: string | null;
  city?: string | null;
  uf?: string | null;
  street?: string | null;
  address_number?: string | null;
  complement?: string | null;
  telephone?: string | null;
  email?: string | null;
  businessId: string;
}

interface Supplier {
  id: string;
  name: string;
  cnpj: string;
  cep?: string | null;
  city?: string | null;
  uf?: string | null;
  street?: string | null;
  address_number?: string | null;
  complement?: string | null;
  telephone?: string | null;
  email?: string | null;
  businessId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ListSuppliersProps {
  page: number;
  pageSize: number;
  businessId: string;
  search?: string;
  ufs?: BrazilianUf[];
  sort?: SupplierSortKey;
  order?: SortOrder;
}

interface ListSuppliersResult {
  data: Supplier[];
  /** Per UF over the base (search applied, UF facet not): cards and options. */
  stateCounts: SupplierStateCount[];
}

/** The editable fields; the company a supplier belongs to never changes. */
type UpdateSupplierFields = Partial<Omit<CreateSupplierProps, "businessId">>;

interface UpdateSupplier {
  supplierData: UpdateSupplierFields;
  supplierId: string;
}

interface SearchSupplierWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  search?: string;
}

interface CursorPaginatedSupplier {
  data: Supplier[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** What still points at a supplier: the history a deletion would orphan. */
interface SupplierReferenceCounts {
  serviceOrders: number;
  parts: number;
  accountsPayable: number;
}

export {
  Supplier,
  CreateSupplierProps,
  ListSuppliersProps,
  ListSuppliersResult,
  UpdateSupplier,
  UpdateSupplierFields,
  SearchSupplierWithCursorProps,
  CursorPaginatedSupplier,
  SupplierReferenceCounts,
};
