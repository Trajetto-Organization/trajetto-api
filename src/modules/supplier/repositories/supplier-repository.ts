import {
  Supplier,
  CreateSupplierProps,
  ListAllSuppliersProps,
  ListSupplierProps,
  UpdateSupplier,
  SearchSupplierWithCursorProps,
  CursorPaginatedSupplier,
} from "../dtos/supplier-dto";

import { ISupplierRepository } from "./ISupplier-repository";
import database from "@/../infra/database";

class SupplierRepository implements ISupplierRepository {
  constructor(private prisma = database) {}

  async createSupplier(supplierData: CreateSupplierProps): Promise<Supplier> {
    const supplierCreated = await this.prisma.supplier.create({
      data: supplierData,
    });

    return supplierCreated;
  }

  async listAllSuppliers({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
  }: ListAllSuppliersProps): Promise<ListSupplierProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const digitSearch = normalizedSearch.replace(/\D/g, "");
    let digitSearchPhone = digitSearch;

    if (digitSearchPhone.startsWith("55") && digitSearchPhone.length > 10) {
      digitSearchPhone = digitSearchPhone.substring(2);
    }

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        { street: { contains: normalizedSearch, mode: "insensitive" } },
        { address_number: { contains: normalizedSearch, mode: "insensitive" } },
        { city: { contains: normalizedSearch, mode: "insensitive" } },
        { uf: { contains: normalizedSearch, mode: "insensitive" } },
        { complement: { contains: normalizedSearch, mode: "insensitive" } },
        { email: { contains: normalizedSearch, mode: "insensitive" } },
        ...(digitSearch
          ? [
              { cep: { contains: digitSearch, mode: "insensitive" } },
              {
                telephone: { contains: digitSearchPhone, mode: "insensitive" },
              },
              { cnpj: { contains: digitSearch, mode: "insensitive" } },
            ]
          : []),
        {
          ...(currentUserRole === "MASTER"
            ? {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              }
            : {}),
        },
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [supplierData, total] = await Promise.all([
      this.prisma.supplier.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          ...(currentUserRole === "MASTER" && {
            business: {
              select: {
                corporate_reason: true,
              },
            },
          }),
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.supplier.count({
        where: whereCondition,
      }),
    ]);

    return { data: supplierData, total };
  }

  async updateSupplier({
    supplierData,
    supplierId,
  }: UpdateSupplier): Promise<Supplier> {
    const filteredData = Object.fromEntries(
      Object.entries(supplierData).filter(([_, value]) => value !== undefined),
    );

    const updatedSupplier = await this.prisma.supplier.update({
      where: {
        id: supplierId,
      },
      data: filteredData,
    });

    return updatedSupplier;
  }

  async findSupplierById(supplierId: string): Promise<Supplier | null> {
    const supplier = await this.prisma.supplier.findUnique({
      where: {
        id: supplierId,
      },
    });

    return supplier;
  }

  async findSupplierByName(name: string): Promise<Supplier | null> {
    const supplier = await this.prisma.supplier.findFirst({
      where: {
        name: {
          equals: name,
          mode: "insensitive",
        },
      },
    });

    return supplier;
  }

  async findSupplierByCnpj(cnpj: string): Promise<Supplier | null> {
    const supplier = await this.prisma.supplier.findFirst({
      where: {
        cnpj,
      },
    });

    return supplier;
  }

  async findSupplierByCnpjAndBusinessId(
    cnpj: string,
    businessId: string,
  ): Promise<Supplier | null> {
    const supplier = await this.prisma.supplier.findFirst({
      where: {
        cnpj,
        businessId,
      },
    });

    return supplier;
  }

  async findSupplierByEmail(email: string): Promise<Supplier | null> {
    const supplier = await this.prisma.supplier.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
    });

    return supplier;
  }

  async findSupplierByNameAndBusinessId(
    name: string,
    businessId: string,
  ): Promise<Supplier | null> {
    const supplier = await this.prisma.supplier.findFirst({
      where: {
        name: {
          equals: name,
          mode: "insensitive",
        },
        businessId,
      },
    });

    return supplier;
  }

  async searchSupplierWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchSupplierWithCursorProps): Promise<CursorPaginatedSupplier> {
    const items = await this.prisma.supplier.findMany({
      where: { businessId },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: {
        created_at: "desc",
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async deleteSupplier(supplierId: string): Promise<Supplier> {
    const deletedSupplier = await this.prisma.supplier.delete({
      where: {
        id: supplierId,
      },
    });

    return deletedSupplier;
  }
}

export { SupplierRepository };
