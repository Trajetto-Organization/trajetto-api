import { inject, injectable } from "tsyringe";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import type { ServiceOrderListRow } from "../../dtos/service-order-dto";

import {
  summarizeServiceOrderList,
  type MaintenanceTypeValue,
  type ServiceOrderListSearchMeta,
  type ServiceOrderSortKey,
  type ServiceOrderStatus,
} from "./service-order-list";

interface ListServiceOrderRequest {
  userId: string;
  /** The MASTER's chosen company; everyone else is pinned to their own. */
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  statuses?: ServiceOrderStatus[];
  maintenanceTypes?: MaintenanceTypeValue[];
  branchIds?: string[];
  sort?: ServiceOrderSortKey;
  order?: SortOrder;
}

interface ListServiceOrderResponse {
  data: ServiceOrderListRow[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: ServiceOrderListSearchMeta;
}

/**
 * One company's service orders, with order, filters and cards answered over
 * the whole company (decision 8.8). The MASTER no longer gets every tenant
 * mixed in one table: the /admin screen names the company, like Entregas.
 */
@injectable()
class ListServiceOrderUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    statuses,
    maintenanceTypes,
    branchIds,
    sort,
    order,
  }: ListServiceOrderRequest): Promise<ListServiceOrderResponse> {
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
      const result = await this.serviceOrder.listServiceOrders({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
        statuses,
        maintenanceTypes,
        branchIds,
      });

      const { total, searchMeta } = summarizeServiceOrderList(
        result.cells,
        result.branchCounts,
        { statuses, maintenanceTypes, branchIds },
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar as ordens de serviço! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListServiceOrderUseCase };
export type { ListServiceOrderRequest, ListServiceOrderResponse };
