import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IPermissionRepository } from "../../repositories/IPermission-repository";
import { PermissionListRow } from "../../dtos/permission-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import type { PermissionKey } from "@/config/permissions";
import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizePermissionList,
  type PermissionFlag,
  type PermissionListSearchMeta,
  type PermissionSortKey,
} from "./permission-list";

interface ListPermissionRequest {
  userId: string;
  /** MASTER picks the company (required); everyone else is pinned to theirs. */
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: PermissionSortKey;
  order?: SortOrder;
  permissionKeys?: PermissionKey[];
  profileAccessIds?: string[];
  read?: PermissionFlag[];
  write?: PermissionFlag[];
}

interface ListPermissionResponse {
  data: PermissionListRow[];
  total: number;
  searchMeta: PermissionListSearchMeta;
}

/**
 * One company's permissions, with sorting, filters and counts answered over
 * the whole company (decision 8.8). The MASTER used to get every company's
 * permissions mixed in one list; /admin now asks for one company.
 */
@injectable()
class ListPermissionUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("PermissionRepository")
    private permission: IPermissionRepository,
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
    permissionKeys,
    profileAccessIds,
    read,
    write,
  }: ListPermissionRequest): Promise<ListPermissionResponse> {
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

    if (businessId) assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(resolvedBusinessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const filters = {
      businessId: resolvedBusinessId,
      search,
      hideProfileId:
        findUser.role === "BUSINESS_USER" ? findUser.profileAccessId : null,
      permissionKeys,
      profileAccessIds,
      read,
      write,
    };

    try {
      const result = await this.permission.listPermission({
        page,
        pageSize,
        sort,
        order,
        ...filters,
      });

      const { total, searchMeta } = summarizePermissionList(
        result.groups,
        filters,
        result.profileNames,
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      throw new AppError("Não foi possível recuperar a lista de permissões!", 500);
    }
  }
}

export { ListPermissionUseCase };
