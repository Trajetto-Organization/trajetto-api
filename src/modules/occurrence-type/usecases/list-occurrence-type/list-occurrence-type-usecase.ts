import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";
import type { ActiveStatus, YesNo } from "@/shared/delivery/catalog-list";
import type { OccurrenceCategoryKey } from "../../rules/occurrence-category-rules";

import { ListOccurrenceTypesResult } from "../../dtos/occurrence-type-dto";
import {
  summarizeOccurrenceTypeList,
  type OccurrenceTypeSortKey,
} from "./occurrence-type-list";

interface ListOccurrenceTypesRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: OccurrenceTypeSortKey;
  order?: SortOrder;
  statuses?: ActiveStatus[];
  blocking?: YesNo[];
  photo?: YesNo[];
  categories?: OccurrenceCategoryKey[];
}

@injectable()
class ListOccurrenceTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    sort,
    order,
    statuses,
    blocking,
    photo,
    categories,
  }: ListOccurrenceTypesRequest): Promise<ListOccurrenceTypesResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // MASTER picks the company explicitly; everyone else is pinned to
    // their own — same resolution every list route in the app uses.
    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    try {
      const { data, groups } = await this.occurrenceType.listOccurrenceTypes({
        page,
        pageSize,
        businessId: resolvedBusinessId,
        search,
        sort,
        order,
        statuses,
        blocking,
        photo,
        categories,
      });

      // Cards and filter counts over the whole company (decision 8.8),
      // never the page on screen.
      const { total, searchMeta } = summarizeOccurrenceTypeList(groups, {
        statuses,
        blocking,
        photo,
        categories,
      });

      return { data, total, meta: searchMeta };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Não foi possível recuperar os tipos de ocorrência!",
        500,
      );
    }
  }
}

export { ListOccurrenceTypeUseCase };
