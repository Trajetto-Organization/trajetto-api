import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IPartRepository } from "@/modules/part/repositories/IPart-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import type { SortOrder } from "@/shared/pagination/list-query";

import type { PartListRow } from "../../dtos/part-dto";

import {
  summarizePartList,
  type PartListSearchMeta,
  type PartSortKey,
} from "./part-list";

interface ListPartRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  supplierIds?: string[];
  sort?: PartSortKey;
  order?: SortOrder;
}

interface ListPartResponse {
  data: PartListRow[];
  total: number;
  searchMeta: PartListSearchMeta;
}

/** One company's parts catalog, answered over the whole catalog (8.8). */
@injectable()
class ListPartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PartRepository")
    private part: IPartRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    supplierIds,
    sort,
    order,
  }: ListPartRequest): Promise<ListPartResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

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
      const result = await this.part.listParts({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
        supplierIds,
      });

      const { total, searchMeta } = summarizePartList(result.supplierCounts, {
        supplierIds,
      });

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar as peças! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListPartUseCase };
export type { ListPartRequest, ListPartResponse };
