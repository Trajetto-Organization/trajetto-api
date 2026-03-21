import {
  Supplier,
  CreateSupplierProps,
  ListAllSuppliersProps,
  ListSupplierProps,
  UpdateSupplier,
  SearchSupplierWithCursorProps,
  CursorPaginatedSupplier,
} from "../dtos/supplier-dto";

interface ISupplierRepository {
  createSupplier: (supplierData: CreateSupplierProps) => Promise<Supplier>;
  listAllSuppliers: (
    listAllSuppliersProps: ListAllSuppliersProps,
  ) => Promise<ListSupplierProps>;
  searchSupplierWithCursor: (
    props: SearchSupplierWithCursorProps,
  ) => Promise<CursorPaginatedSupplier>;
  updateSupplier: ({
    supplierData,
    supplierId,
  }: UpdateSupplier) => Promise<Supplier>;
  findSupplierById: (supplierId: string) => Promise<Supplier | null>;
  findSupplierByName: (name: string) => Promise<Supplier | null>;
  findSupplierByCnpj: (cnpj: string) => Promise<Supplier | null>;
  findSupplierByCnpjAndBusinessId: (
    cnpj: string,
    businessId: string,
  ) => Promise<Supplier | null>;
  findSupplierByEmail: (email: string) => Promise<Supplier | null>;
  findSupplierByNameAndBusinessId: (
    name: string,
    businessId: string,
  ) => Promise<Supplier | null>;
  deleteSupplier: (supplierId: string) => Promise<Supplier>;
}

export { ISupplierRepository };
