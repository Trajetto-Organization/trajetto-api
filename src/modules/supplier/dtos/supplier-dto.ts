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

interface ListSupplierBusinessProps {
  page: number;
  pageSize: number;
  businessId: string;
}

interface UpdateSupplier {
  supplierData: Partial<CreateSupplierProps>;
  supplierId: string;
}

export {
  Supplier,
  CreateSupplierProps,
  ListSupplierByBusinessIdProps,
  ListSupplierProps,
  UpdateSupplier,
  ListAllSuppliersProps,
  ListSupplierBusinessProps,
};
