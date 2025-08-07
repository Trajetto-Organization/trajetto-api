import {
  Supplier,
  CreateSupplierProps,
  ListAllSuppliersProps,
  ListSupplierProps,
  UpdateSupplier,
  ListSupplierBusinessProps,
} from "../dtos/supplier-dto";

import { ISupplierRepository } from "./ISupplier-repository";
import database from "@/../infra/database";

import {
  formatCep,
  formatCnpj,
  formatDate,
  formatTelephone,
} from "@/config/format-values";

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
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const supplierData = await this.prisma.supplier.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      orderBy: {
        created_at: "desc",
      },
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
      },
    });

    const total = await this.prisma.supplier.count({
      where: whereCondition,
    });

    const transformedSupplierData = supplierData.map((supplier) => ({
      id: supplier.id ?? "N/A",
      name: supplier.name ?? "N/A",
      cnpj: supplier.cnpj ? formatCnpj(supplier.cnpj) : "N/A",
      cep: supplier.cep ? formatCep(supplier.cep) : "N/A",
      city: supplier.city ?? "N/A",
      uf: supplier.uf ?? "N/A",
      street: supplier.street ?? "N/A",
      address_number: supplier.address_number ?? "N/A",
      complement: supplier.complement ?? "N/A",
      telephone: supplier.telephone
        ? formatTelephone(supplier.telephone)
        : "N/A",
      email: supplier.email ?? "N/A",
      businessId: supplier.businessId ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { business_name: supplier.business?.corporate_reason ?? "N/A" }
        : {}),
      created_at: formatDate(supplier.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(supplier.updated_at, "pt-BR") ?? "N/A",
    }));

    return { data: transformedSupplierData, total };
  }

  async listSupplierBusiness({
    page,
    pageSize,
    businessId,
  }: ListSupplierBusinessProps): Promise<ListSupplierProps> {
    const skip = (page - 1) * pageSize;

    const supplierBusinessData = await this.prisma.supplier.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.supplier.count({
      where: {
        businessId,
      },
    });

    return { data: supplierBusinessData, total };
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
