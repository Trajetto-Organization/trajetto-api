import { v7 as uuidV7 } from "uuid";
import { IBusinessRepository } from "../IBusiness-repository";

import {
  CreateBusinessProps,
  Business,
  ListBusinessProps,
  UpdateBusiness,
  ListBusinessByBusinessIdProps,
  SearchBusinessWithCursorProps,
  CursorPaginatedBusiness,
} from "../../dtos/business-dto";

class InMemoryBusinessRepository implements IBusinessRepository {
  public business: Business[] = [];

  async createBusiness(businessData: CreateBusinessProps): Promise<Business> {
    const newBusiness: Business = {
      id: uuidV7(),
      ...businessData,
      is_active: true,
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

  async updateAILimit(
    businessId: string,
    ai_analysis_limit: number,
  ): Promise<Business> {
    const index = this.business.findIndex((b) => b.id === businessId);
    const currentUsed = this.business[index].ai_analysis_used ?? 0;

    this.business[index] = {
      ...this.business[index],
      ai_analysis_limit,
      ai_analysis_used: Math.min(currentUsed, ai_analysis_limit),
      ai_analysis_reset_at:
        this.business[index].ai_analysis_reset_at ?? new Date(),
    };

    return this.business[index];
  }

  async searchBusinessWithCursor({
    limit = 10,
    cursor,
    businessId,
    currentUserRole,
    search,
  }: SearchBusinessWithCursorProps): Promise<CursorPaginatedBusiness> {
    let filtered = this.business.filter(
      (business) =>
        business.is_active &&
        (currentUserRole === "MASTER" || business.id === businessId),
    );

    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((business) =>
        [
          business.corporate_reason,
          business.fantasy_name ?? "",
          business.cnpj,
          business.email,
          business.responsible_name,
        ].some((value) => value.toLowerCase().includes(term)),
      );
    }

    if (cursor) {
      const cursorIndex = filtered.findIndex((b) => b.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async findAIUsage(businessId: string) {
    const found = this.business.find((b) => b.id === businessId);

    if (!found) {
      return null;
    }

    return {
      id: found.id || "",
      corporate_reason: found.corporate_reason,
      fantasy_name: found.fantasy_name || null,
      ai_analysis_limit: found.ai_analysis_limit ?? 0,
      ai_analysis_used: found.ai_analysis_used ?? 0,
      ai_analysis_reset_at: found.ai_analysis_reset_at ?? new Date(),
    };
  }
  async countBusinessDependencies(
    businessId: string,
  ): Promise<{ branches: number; users: number; drivers: number }> {
    return { branches: 0, users: 0, drivers: 0 };
  }
}

export { InMemoryBusinessRepository };
