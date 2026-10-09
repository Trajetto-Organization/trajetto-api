import { inject, injectable } from "tsyringe";
import { Business } from "../../dtos/business-dto";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "../../repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeBusinessList,
  type BusinessListSearchMeta,
  type BusinessSortKey,
  type BusinessStatus,
  type BusinessUf,
} from "./business-list";

interface ListBusinessRequest {
  userId: string;
  page: number;
  pageSize: number;
  search?: string;
  statuses?: BusinessStatus[];
  ufs?: BusinessUf[];
  sort?: BusinessSortKey;
  order?: SortOrder;
}

interface ListBusinessResponse {
  data: Business[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and facet options. */
  searchMeta: BusinessListSearchMeta;
}

/**
 * The companies table of /admin (decision 8.8): the order, the status and
 * UF filters and the cards answered over every company, not over the page.
 */
@injectable()
class ListBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    page,
    pageSize,
    search,
    statuses,
    ufs,
    sort,
    order,
  }: ListBusinessRequest): Promise<ListBusinessResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.business.listBusiness({
        page,
        pageSize,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
        search,
        statuses,
        ufs,
        sort,
        order,
      });

      const { total, searchMeta } = summarizeBusinessList(result.groups, result.topCities, {
        statuses,
        ufs,
      });

      return { data: result.data, total, searchMeta };
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de empresas!",
        500,
      );
    }
  }
}

export { ListBusinessUseCase };
export type { ListBusinessRequest, ListBusinessResponse };
