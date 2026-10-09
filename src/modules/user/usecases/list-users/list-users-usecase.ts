import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ListUsersProps } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeUserList,
  type ListedRole,
  type UserAccess,
  type UserListSearchMeta,
  type UserSortKey,
  type UserTwoFactor,
} from "./user-list";

interface ListUsersRequest {
  userId: string;
  /** MASTER picks the company (required); everyone else is pinned to theirs. */
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: UserSortKey;
  order?: SortOrder;
  roles?: ListedRole[];
  access?: UserAccess[];
  twoFactor?: UserTwoFactor[];
  profileAccessIds?: string[];
}

interface ListUsersResponse {
  data: ListUsersProps[];
  /** Rows of search + every filter: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: UserListSearchMeta;
}

/**
 * One company's users, with sorting, filters and cards answered over the
 * whole company, never over the page on screen (decision 8.8). The MASTER
 * used to get every company's users mixed in one list; /admin now asks for
 * the company picked at the top, like every other back-office list.
 */
@injectable()
class ListUsersUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    sort,
    order,
    roles,
    access,
    twoFactor,
    profileAccessIds,
  }: ListUsersRequest): Promise<ListUsersResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const resolvedBusinessId =
      findUser.role === "MASTER" ? businessId : findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    // A foreign businessId from anyone but the MASTER is refused, not
    // silently swapped for their own.
    if (businessId) assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(resolvedBusinessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const filters = { roles, access, twoFactor, profileAccessIds };

    try {
      const result = await this.user.listUsers({
        page,
        pageSize,
        sort,
        order,
        search,
        currentUserId: findUser.id,
        currentUserRole: findUser.role,
        businessId: resolvedBusinessId,
        ...filters,
      });

      const { total, searchMeta } = summarizeUserList(
        result.groups,
        filters,
        result.profileNames,
        result.emailVerified,
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError("Não foi possível recuperar a lista de usuários!", 500);
    }
  }
}

export { ListUsersUseCase };
export type { ListUsersRequest, ListUsersResponse };
