import { compareCodePoints } from "@/shared/pagination/in-memory-order";
import { afterCursor } from "@/shared/in-memory/cursor";
import { recordNotFound } from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { ISupplierRepository } from "../ISupplier-repository";

import {
  Supplier,
  CreateSupplierProps,
  ListSuppliersProps,
  ListSuppliersResult,
  UpdateSupplier,
  SearchSupplierWithCursorProps,
  CursorPaginatedSupplier,
  SupplierReferenceCounts,
} from "../../dtos/supplier-dto";

import {
  SUPPLIER_SORT_FALLBACK,
  digitsOf,
  type SupplierSortKey,
} from "../../usecases/list-supplier/supplier-list";
import type { SortOrder } from "@/shared/pagination/list-query";

const NO_REFERENCES: SupplierReferenceCounts = {
  serviceOrders: 0,
  parts: 0,
  accountsPayable: 0,
};

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();

/** created_at desc, id desc: the Prisma tiebreaker, so pages cut the same. */
function newestFirst(a: Supplier, b: Supplier): number {
  const byCreated =
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

  return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
}

function compareColumn(
  a: Supplier,
  b: Supplier,
  key: SupplierSortKey,
  order: SortOrder,
): number {
  const direction = order === "asc" ? 1 : -1;

  if (key === "created_at" || key === "updated_at") {
    return (
      direction *
      (new Date(a[key]).getTime() - new Date(b[key]).getTime())
    );
  }

  const left = a[key] ?? null;
  const right = b[key] ?? null;

  // NULLS LAST in both directions, as the Prisma order states.
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  // Code point order: what Postgres does on the deployed image (musl
  // en_US.utf8). The pt-BR linguistic order put "água" before "Bravo".
  return direction * compareCodePoints(left, right);
}

class InMemorySupplierRepository implements ISupplierRepository {
  public suppliers: Supplier[] = [];

  /**
   * Seeds what the real tables would count (service orders, parts, bills):
   * the twin has no rows of those tables.
   */
  public references = new Map<string, SupplierReferenceCounts>();

  async createSupplier(supplierData: CreateSupplierProps): Promise<Supplier> {
    const newSupplier: Supplier = {
      id: uuidV7(),
      name: supplierData.name,
      cnpj: supplierData.cnpj,
      cep: supplierData.cep ?? null,
      city: supplierData.city ?? null,
      uf: supplierData.uf ?? null,
      street: supplierData.street ?? null,
      address_number: supplierData.address_number ?? null,
      complement: supplierData.complement ?? null,
      telephone: supplierData.telephone ?? null,
      email: supplierData.email ?? null,
      businessId: supplierData.businessId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.suppliers.push(newSupplier);
    return newSupplier;
  }

  /** Same semantics as supplierListWhere: literal, case-insensitive substrings. */
  private matchesSearch(supplier: Supplier, search?: string): boolean {
    const term = search?.trim() ?? "";

    if (!term) return true;

    const needle = term.toLowerCase();
    const { digits, phoneDigits } = digitsOf(term);

    return (
      [
        supplier.id,
        supplier.name,
        supplier.email,
        supplier.city,
        supplier.street,
      ].some((value) => lower(value).includes(needle)) ||
      (digits.length > 0 &&
        ((supplier.cnpj ?? "").includes(digits) ||
          (supplier.cep ?? "").includes(digits) ||
          (supplier.telephone ?? "").includes(phoneDigits)))
    );
  }

  async listSuppliers({
    page,
    pageSize,
    businessId,
    search,
    ufs,
    sort,
    order,
  }: ListSuppliersProps): Promise<ListSuppliersResult> {
    const base = this.suppliers.filter(
      (supplier) =>
        supplier.businessId === businessId &&
        this.matchesSearch(supplier, search),
    );

    const matching = base.filter(
      (supplier) =>
        !ufs?.length ||
        (supplier.uf !== null &&
          supplier.uf !== undefined &&
          (ufs as string[]).includes(supplier.uf)),
    );

    const key = sort ?? SUPPLIER_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : SUPPLIER_SORT_FALLBACK.order);

    const ordered = [...matching].sort(
      (a, b) => compareColumn(a, b, key, direction) || newestFirst(a, b),
    );

    const skip = (page - 1) * pageSize;

    const groups = new Map<
      string | null,
      { count: number; withTelephone: number; withEmail: number }
    >();

    for (const supplier of base) {
      const uf = supplier.uf ?? null;
      const group = groups.get(uf) ?? {
        count: 0,
        withTelephone: 0,
        withEmail: 0,
      };

      group.count += 1;
      if (supplier.telephone !== null && supplier.telephone !== undefined) {
        group.withTelephone += 1;
      }
      if (supplier.email !== null && supplier.email !== undefined) {
        group.withEmail += 1;
      }

      groups.set(uf, group);
    }

    return {
      data: ordered.slice(skip, skip + pageSize),
      stateCounts: Array.from(groups.entries()).map(([uf, group]) => ({
        uf,
        ...group,
      })),
    };
  }

  async updateSupplier({
    supplierData,
    supplierId,
  }: UpdateSupplier): Promise<Supplier> {
    const index = this.suppliers.findIndex(
      (supplier) => supplier.id === supplierId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    // Like Prisma: `undefined` is "not sent", `null` clears the column. The
    // company is never rewritten.
    const filteredData = Object.fromEntries(
      Object.entries(supplierData).filter(
        ([key, value]) => value !== undefined && key !== "businessId",
      ),
    );

    const updatedSupplier: Supplier = {
      ...this.suppliers[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.suppliers[index] = updatedSupplier;
    return updatedSupplier;
  }

  async findSupplierById(supplierId: string): Promise<Supplier | null> {
    return this.suppliers.find((supplier) => supplier.id === supplierId) ?? null;
  }

  async findSupplierByCnpjAndBusinessId(
    cnpj: string,
    businessId: string,
  ): Promise<Supplier | null> {
    return (
      this.suppliers.find(
        (supplier) =>
          supplier.cnpj === cnpj && supplier.businessId === businessId,
      ) ?? null
    );
  }

  async findSupplierByEmailAndBusinessId(
    email: string,
    businessId: string,
  ): Promise<Supplier | null> {
    // Case-insensitive, like insensitiveEquals on the real table.
    return (
      this.suppliers.find(
        (supplier) =>
          supplier.businessId === businessId &&
          supplier.email !== null &&
          supplier.email !== undefined &&
          lower(supplier.email) === lower(email),
      ) ?? null
    );
  }

  async findSupplierByNameAndBusinessId(
    name: string,
    businessId: string,
  ): Promise<Supplier | null> {
    return (
      this.suppliers.find(
        (supplier) =>
          supplier.businessId === businessId &&
          lower(supplier.name) === lower(name),
      ) ?? null
    );
  }

  async countSupplierReferences(
    supplierId: string,
  ): Promise<SupplierReferenceCounts> {
    return { ...(this.references.get(supplierId) ?? NO_REFERENCES) };
  }

  async deleteUnreferencedSupplier(
    supplierId: string,
    businessId: string,
  ): Promise<Supplier | null> {
    const index = this.suppliers.findIndex(
      (supplier) =>
        supplier.id === supplierId && supplier.businessId === businessId,
    );

    if (index === -1) return null;

    const references = this.references.get(supplierId) ?? NO_REFERENCES;

    if (
      references.serviceOrders + references.parts + references.accountsPayable >
      0
    ) {
      return null;
    }

    return this.suppliers.splice(index, 1)[0];
  }

  async searchSupplierWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchSupplierWithCursorProps): Promise<CursorPaginatedSupplier> {
    const term = search?.trim() ?? "";
    const needle = term.toLowerCase();
    const { digits } = digitsOf(term);

    let filtered = this.suppliers
      .filter(
        (supplier) =>
          supplier.businessId === businessId &&
          (!term ||
            [supplier.name, supplier.email, supplier.city].some((value) =>
              lower(value).includes(needle),
            ) ||
            (digits.length > 0 && (supplier.cnpj ?? "").includes(digits))),
      )
      .sort(newestFirst);

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.suppliers, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { InMemorySupplierRepository };
