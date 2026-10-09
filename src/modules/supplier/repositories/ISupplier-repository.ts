import {
  Supplier,
  CreateSupplierProps,
  ListSuppliersProps,
  ListSuppliersResult,
  UpdateSupplier,
  SearchSupplierWithCursorProps,
  CursorPaginatedSupplier,
  SupplierReferenceCounts,
} from "../dtos/supplier-dto";

/**
 * Every uniqueness lookup here is scoped to one company (decision 8.1): two
 * carriers may use the same workshop, and a global lookup both refused the
 * second one and told it that the e-mail existed somewhere else.
 */
interface ISupplierRepository {
  createSupplier: (supplierData: CreateSupplierProps) => Promise<Supplier>;
  listSuppliers: (props: ListSuppliersProps) => Promise<ListSuppliersResult>;
  searchSupplierWithCursor: (
    props: SearchSupplierWithCursorProps,
  ) => Promise<CursorPaginatedSupplier>;
  updateSupplier: ({
    supplierData,
    supplierId,
  }: UpdateSupplier) => Promise<Supplier>;
  findSupplierById: (supplierId: string) => Promise<Supplier | null>;
  findSupplierByCnpjAndBusinessId: (
    cnpj: string,
    businessId: string,
  ) => Promise<Supplier | null>;
  findSupplierByEmailAndBusinessId: (
    email: string,
    businessId: string,
  ) => Promise<Supplier | null>;
  findSupplierByNameAndBusinessId: (
    name: string,
    businessId: string,
  ) => Promise<Supplier | null>;
  /** Service orders, parts and bills that still name the supplier. */
  countSupplierReferences: (
    supplierId: string,
  ) => Promise<SupplierReferenceCounts>;
  /**
   * Deletes the supplier of this company only while nothing references it,
   * checked under a row lock in the delete's own transaction, so a link made
   * concurrently is either counted or refused by its foreign key — never
   * silently set to NULL. Null when nothing was deleted.
   */
  deleteUnreferencedSupplier: (
    supplierId: string,
    businessId: string,
  ) => Promise<Supplier | null>;
}

export { ISupplierRepository };
