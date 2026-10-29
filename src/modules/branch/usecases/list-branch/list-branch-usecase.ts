import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import { Branch } from "../../dtos/branch-dto";
import {
  summarizeBranchList,
  type BranchListSearchMeta,
  type BranchSortKey,
  type BranchStatus,
  type BranchUf,
} from "./branch-list";

interface ListBranchRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  statuses?: BranchStatus[];
  ufs?: BranchUf[];
  sort?: BranchSortKey;
  order?: SortOrder;
}

interface ListBranchResponse {
  data: Branch[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and facet options. */
  searchMeta: BranchListSearchMeta;
}

/**
 * One company's branches, with the cards and filters answered over the whole
 * company (decision 8.8). The MASTER names the company; there is no longer
 * an "every company" list, which mixed tenants on one page and made the
 * cards count the ten rows on screen.
 */
@injectable()
class ListBranchUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    statuses,
    ufs,
    sort,
    order,
  }: ListBranchRequest): Promise<ListBranchResponse> {
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
      const result = await this.branch.listAllBranches({
        page,
        pageSize,
        businessId: resolvedBusinessId,
        search,
        statuses,
        ufs,
        sort,
        order,
      });

      const { total, searchMeta } = summarizeBranchList(
        result.groups,
        result.withFantasyName,
        { statuses, ufs },
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar as filiais! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListBranchUseCase };
export type { ListBranchRequest, ListBranchResponse };
