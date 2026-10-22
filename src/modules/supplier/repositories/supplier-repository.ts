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

import { ISupplierRepository } from "./ISupplier-repository";
import database from "@/../infra/database";

import { resolveOrderBy } from "@/shared/pagination/list-query";
import { buildSearchOr } from "@/shared/pagination/search-or";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

import {
  SUPPLIER_SORT,
  digitsOf,
  supplierListWhere,
} from "../usecases/list-supplier/supplier-list";

class SupplierRepository implements ISupplierRepository {
  constructor(private prisma = database) {}

  async createSupplier(supplierData: CreateSupplierProps): Promise<Supplier> {
    return this.prisma.supplier.create({ data: supplierData });
  }

  async listSuppliers({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListSuppliersProps): Promise<ListSuppliersResult> {
    // The page and one GROUP BY uf side by side (two connections, the
    // budget of a list screen): the cards, the pager total and the UF
    // options all come out of the grouped counts.
    const [data, grouped] = await Promise.all([
      this.prisma.supplier.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: supplierListWhere(filters, { withUfFacet: true }),
        orderBy: resolveOrderBy(SUPPLIER_SORT, { sort, order }),
      }),
      this.prisma.supplier.groupBy({
        by: ["uf"],
        where: supplierListWhere(filters, { withUfFacet: false }),
        // `_count` of a column counts its non-null values.
        _count: { _all: true, telephone: true, email: true },
      }),
    ]);

    return {
      data,
      stateCounts: grouped.map((group) => ({
        uf: group.uf,
        count: group._count._all,
        withTelephone: group._count.telephone,
        withEmail: group._count.email,
      })),
    };
  }

  async updateSupplier({
    supplierData,
    supplierId,
  }: UpdateSupplier): Promise<Supplier> {
    // `undefined` = not sent. `businessId` is never written here: a supplier
    // moved to another company would leave its parts and service orders
    // pointing across tenants.
    const filteredData = Object.fromEntries(
      Object.entries(supplierData).filter(
        ([key, value]) => value !== undefined && key !== "businessId",
      ),
    );

    return this.prisma.supplier.update({
      where: { id: supplierId },
      data: filteredData,
    });
  }

  async findSupplierById(supplierId: string): Promise<Supplier | null> {
    return this.prisma.supplier.findUnique({ where: { id: supplierId } });
  }

  async findSupplierByCnpjAndBusinessId(
    cnpj: string,
    businessId: string,
  ): Promise<Supplier | null> {
    return this.prisma.supplier.findFirst({ where: { cnpj, businessId } });
  }

  async findSupplierByEmailAndBusinessId(
    email: string,
    businessId: string,
  ): Promise<Supplier | null> {
    return this.prisma.supplier.findFirst({
      where: {
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        email: insensitiveEquals(email),
        businessId,
      },
    });
  }

  async findSupplierByNameAndBusinessId(
    name: string,
    businessId: string,
  ): Promise<Supplier | null> {
    return this.prisma.supplier.findFirst({
      where: { name: insensitiveEquals(name), businessId },
    });
  }

  async searchSupplierWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchSupplierWithCursorProps): Promise<CursorPaginatedSupplier> {
    const term = search?.trim() ?? "";
    const { digits } = digitsOf(term);

    const items = await this.prisma.supplier.findMany({
      where: {
        businessId,
        ...(term &&
          buildSearchOr([
            { name: { contains: term, mode: "insensitive" as const } },
            { email: { contains: term, mode: "insensitive" as const } },
            { city: { contains: term, mode: "insensitive" as const } },
            ...(digits ? [{ cnpj: { contains: digits } }] : []),
          ])),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countSupplierReferences(
    supplierId: string,
  ): Promise<SupplierReferenceCounts> {
    // One query: a relation `_count` is a correlated subquery per relation.
    const found = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: {
        _count: {
          select: { serviceOrders: true, parts: true, accountsPayable: true },
        },
      },
    });

    return {
      serviceOrders: found?._count.serviceOrders ?? 0,
      parts: found?._count.parts ?? 0,
      accountsPayable: found?._count.accountsPayable ?? 0,
    };
  }

  async deleteUnreferencedSupplier(
    supplierId: string,
    businessId: string,
  ): Promise<Supplier | null> {
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE first. A part, service order or bill inserted with this
      // supplier holds FOR KEY SHARE on the row until it commits, and the two
      // locks conflict: once this returns, such an insert has either
      // committed (and the counts below, each a new READ COMMITTED snapshot,
      // see it) or waits for this transaction and then fails its foreign key.
      // A single DELETE … WHERE NOT EXISTS was not enough: its subqueries read
      // the snapshot taken before it waited, and the SET NULL cascade then
      // erased the new link.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "supplier"
         WHERE "id" = ${supplierId} AND "businessId" = ${businessId}
         FOR UPDATE`;

      if (locked.length === 0) return null;

      // One connection inside the transaction: sequential, not Promise.all.
      const serviceOrders = await tx.serviceOrder.count({
        where: { supplierId },
      });
      const parts = await tx.part.count({ where: { supplierId } });
      const accountsPayable = await tx.accountPayable.count({
        where: { supplierId },
      });

      if (serviceOrders + parts + accountsPayable > 0) return null;

      return tx.supplier.delete({ where: { id: supplierId } });
    });
  }
}

export { SupplierRepository };
