import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ListProfileAccessResult } from "../../dtos/profile-access-dto";
import { IProfileAccessRepository } from "../../repositories/IProfile-access-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeProfileList,
  type ProfileSortKey,
} from "./profile-access-list";

interface ListProfileAccessRequest {
  userId: string;
  /** MASTER picks the company (required); everyone else is pinned to theirs. */
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: ProfileSortKey;
  order?: SortOrder;
}

/**
 * One company's access profiles, with the users and permissions each holds,
 * sorted by the database, and the cards over the whole search (decision 8.8). The MASTER used to get every
 * company's profiles mixed in one list; /admin now asks for one company.
 */
@injectable()
class ListProfileAccessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
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
  }: ListProfileAccessRequest): Promise<ListProfileAccessResult> {
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

    const findBusiness =
      await this.business.findBusinessById(resolvedBusinessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const { data, total, usage } = await this.profileAccess.listProfileAccess(
        {
          page,
          pageSize,
          sort,
          order,
          search,
          businessId: resolvedBusinessId,
          hideProfileId:
            findUser.role === "BUSINESS_USER" ? findUser.profileAccessId : null,
        },
      );

      // The cards count the whole search of the company (decision 8.8),
      // never the page on screen.
      return { data, total, meta: summarizeProfileList(usage) };
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de perfis de acesso!",
        500,
      );
    }
  }
}

export { ListProfileAccessUseCase };
