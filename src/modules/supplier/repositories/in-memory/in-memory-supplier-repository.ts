import { v4 as uuidV4 } from "uuid";

import { ISupplierRepository } from "../ISupplier-repository";
import {
  Supplier,
  CreateSupplierProps,
  ListAllSuppliersProps,
  ListSupplierProps,
  UpdateSupplier,
  ListSupplierBusinessProps,
} from "../../dtos/supplier-dto";

class InMemorySupplierRepository implements ISupplierRepository {
  public suppliers: Supplier[] = [];

  async createSupplier(supplierData: CreateSupplierProps): Promise<Supplier> {
    const newSupplier: Supplier = {
      id: uuidV4(),
      name: supplierData.name,
      cnpj: supplierData.cnpj,
      cep: supplierData.cep || null,
      city: supplierData.city || null,
      uf: supplierData.uf || null,
      street: supplierData.street || null,
      address_number: supplierData.address_number || null,
      complement: supplierData.complement || null,
      telephone: supplierData.telephone || null,
      email: supplierData.email || null,
      businessId: supplierData.businessId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.suppliers.push(newSupplier);
    return newSupplier;
  }

  async listAllSuppliers({
    page,
    pageSize,
    businessId,
    search,
  }: ListAllSuppliersProps): Promise<ListSupplierProps> {
    let filteredSuppliers = this.suppliers.filter(
      (supplier) => supplier.businessId === businessId,
    );

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredSuppliers = filteredSuppliers.filter(
        (supplier) =>
          supplier.name.toLowerCase().includes(searchTerm) ||
          supplier.cnpj.includes(searchTerm) ||
          (supplier.email && supplier.email.toLowerCase().includes(searchTerm)),
      );
    }

    const skip = (page - 1) * pageSize;
    const data = filteredSuppliers.slice(skip, skip + pageSize);

    const total = filteredSuppliers.length;
    return { data, total };
  }

  async listSupplierBusiness({
    page,
    pageSize,
    businessId,
  }: ListSupplierBusinessProps): Promise<ListSupplierProps> {
    const filteredSuppliers = this.suppliers.filter(
      (supplier) => supplier.businessId === businessId,
    );

    const skip = (page - 1) * pageSize;
    const data = filteredSuppliers.slice(skip, skip + pageSize);

    const total = filteredSuppliers.length;
    return { data, total };
  }

  async updateSupplier({
    supplierData,
    supplierId,
  }: UpdateSupplier): Promise<Supplier> {
    const index = this.suppliers.findIndex(
      (supplier) => supplier.id === supplierId,
    );

    if (index === -1) {
      throw new Error("Supplier not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(supplierData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
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
    const supplier = this.suppliers.find(
      (supplier) => supplier.id === supplierId,
    );

    return supplier || null;
  }

  async findSupplierByName(name: string): Promise<Supplier | null> {
    const supplier = this.suppliers.find((supplier) => supplier.name === name);

    return supplier || null;
  }

  async findSupplierByCnpj(cnpj: string): Promise<Supplier | null> {
    const supplier = this.suppliers.find((supplier) => supplier.cnpj === cnpj);

    return supplier || null;
  }

  async findSupplierByCnpjAndBusinessId(
    cnpj: string,
    businessId: string,
  ): Promise<Supplier | null> {
    const supplier = this.suppliers.find(
      (supplier) =>
        supplier.cnpj === cnpj && supplier.businessId === businessId,
    );

    return supplier || null;
  }

  async findSupplierByEmail(email: string): Promise<Supplier | null> {
    const supplier = this.suppliers.find(
      (supplier) => supplier.email === email,
    );

    return supplier || null;
  }

  async findSupplierByNameAndBusinessId(
    name: string,
    businessId: string,
  ): Promise<Supplier | null> {
    const supplier = this.suppliers.find(
      (supplier) =>
        supplier.name === name && supplier.businessId === businessId,
    );

    return supplier || null;
  }

  async deleteSupplier(supplierId: string): Promise<Supplier> {
    const index = this.suppliers.findIndex(
      (supplier) => supplier.id === supplierId,
    );

    if (index === -1) {
      throw new Error("Supplier not found");
    }

    const deletedSupplier = this.suppliers.splice(index, 1)[0];
    return deletedSupplier;
  }
}

export { InMemorySupplierRepository };
