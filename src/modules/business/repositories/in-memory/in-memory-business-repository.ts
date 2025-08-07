import { v4 as uuidV4 } from "uuid";

import { IBusinessRepository } from "../IBusiness-repository";
import {
  CreateBusinessProps,
  Business,
  ListBusinessProps,
  UpdateBusiness,
  ListBusinessByBusinessIdProps,
} from "../../dtos/business-dto";

class InMemoryBusinessRepository implements IBusinessRepository {
  public business: Business[] = [];

  async createBusiness(businessData: CreateBusinessProps): Promise<Business> {
    const newBusiness: Business = {
      id: uuidV4(),
      ...businessData,
      erp_code: businessData.erp_code || null,
      complement: businessData.complement || null,
    };

    this.business.push(newBusiness);
    return newBusiness;
  }

  async listBusiness({
    page,
    pageSize,
  }: ListBusinessByBusinessIdProps): Promise<ListBusinessProps> {
    const skip = (page - 1) * pageSize;

    const data = this.business.slice(skip, skip + pageSize);
    const total = this.business.length;

    return { data, total };
  }

  async updateBusiness({
    businessData,
    businessId,
  }: UpdateBusiness): Promise<Business> {
    const index = this.business.findIndex((b) => b.id === businessId);

    const filteredData = Object.fromEntries(
      Object.entries(businessData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updatedBusiness: Business = {
      ...this.business[index],
      ...filteredData,
    };

    this.business[index] = updatedBusiness;
    return updatedBusiness;
  }

  async deleteBusiness(businessId: string): Promise<Business> {
    const index = this.business.findIndex((b) => b.id === businessId);

    const deletedBusiness = this.business.splice(index, 1)[0];
    return deletedBusiness;
  }

  async findBusinessById(businessId: string): Promise<Business | null> {
    const found = this.business.find((b) => b.id === businessId);

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByCnpj(cnpj: string): Promise<Business | null> {
    const found = this.business.find((b) => b.cnpj === cnpj);

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByCorporateReason(
    corporateReason: string,
  ): Promise<Business | null> {
    const found = this.business.find(
      (b) =>
        b.corporate_reason &&
        b.corporate_reason.toLowerCase() === corporateReason.toLowerCase(),
    );

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByErpcode(erpCode: string): Promise<Business | null> {
    const found = this.business.find(
      (b) => b.erp_code && b.erp_code.toLowerCase() === erpCode.toLowerCase(),
    );

    if (!found) {
      return null;
    }

    return found;
  }

  async findBusinessByEmail(email: string): Promise<Business | null> {
    const found = this.business.find(
      (b) => b.email && b.email.toLowerCase() === email.toLowerCase(),
    );

    if (!found) {
      return null;
    }

    return found;
  }
}

export { InMemoryBusinessRepository };
