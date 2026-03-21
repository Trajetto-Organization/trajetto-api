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

interface ListSupplierByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole: string;
  search?: string;
}

interface ListAllSuppliersProps {
  page: number;
  pageSize: number;
  currentUserRole: string;
  businessId: string;
  search?: string;
}

interface ListSupplierProps {
  data: Supplier[];
  total: number;
}

interface UpdateSupplier {
  supplierData: Partial<CreateSupplierProps>;
  supplierId: string;
}

interface SearchSupplierWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedSupplier {
  data: Supplier[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  Supplier,
  CreateSupplierProps,
  ListSupplierByBusinessIdProps,
  ListSupplierProps,
  UpdateSupplier,
  ListAllSuppliersProps,
  SearchSupplierWithCursorProps,
  CursorPaginatedSupplier,
};
