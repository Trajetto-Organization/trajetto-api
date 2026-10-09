import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IServiceOrderPartRepository } from "@/modules/service-order-part/repositories/IService-order-part-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import type { ServiceOrderPart } from "../../dtos/service-order-part-dto";

import {
  summarizeServiceOrderPartList,
  type ServiceOrderPartListSearchMeta,
  type ServiceOrderPartSortKey,
} from "./service-order-part-list";

interface ListServiceOrderPartRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  partIds?: string[];
  serviceOrderIds?: string[];
  sort?: ServiceOrderPartSortKey;
  order?: SortOrder;
}

interface ListServiceOrderPartResponse {
  data: ServiceOrderPart[];
  total: number;
  searchMeta: ServiceOrderPartListSearchMeta;
}

/** One company's service order lines, answered over the whole company (8.8). */
@injectable()
class ListServiceOrderPartUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderPartRepository")
    private serviceOrderPart: IServiceOrderPartRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    partIds,
    serviceOrderIds,
    sort,
    order,
  }: ListServiceOrderPartRequest): Promise<ListServiceOrderPartResponse> {
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
      const result = await this.serviceOrderPart.listServiceOrderParts({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
        partIds,
        serviceOrderIds,
      });

      const { total, searchMeta } = summarizeServiceOrderPartList(
        result.aggregate,
        result.partCounts,
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar as peças das ordens de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListServiceOrderPartUseCase };
