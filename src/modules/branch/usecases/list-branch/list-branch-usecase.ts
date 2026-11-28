import { inject, injectable } from "tsyringe";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import { Branch } from "../../dtos/branch-dto";
import { isHeadOffice } from "../../branch-head-office";
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

/**
 * A row of the list: the branch, and whether it is the company's head
 * office — a mirror of the company that Filiais shows read-only
 * (branch-head-office.ts).
 */
type ListedBranch = Branch & { is_head_office: boolean };

interface ListBranchResponse {
  data: ListedBranch[];
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
    /**
     * The company's CNPJ, to mark its head office. Absent (suites that
     * build the use case by hand), no row is marked.
     */
    @inject("BusinessRepository")
    private business?: IBusinessRepository,
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
      const [result, company] = await Promise.all([
        this.branch.listAllBranches({
          page,
          pageSize,
          businessId: resolvedBusinessId,
          search,
          statuses,
          ufs,
          sort,
          order,
        }),
        this.business?.findBusinessById(resolvedBusinessId) ?? null,
      ]);

      const { total, searchMeta } = summarizeBranchList(
        result.groups,
        result.withFantasyName,
        { statuses, ufs },
      );

      const data = result.data.map((row) => ({
        ...row,
        is_head_office: company ? isHeadOffice(row, company) : false,
      }));

      return { data, total, searchMeta };
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
