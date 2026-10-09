import { inject, injectable } from "tsyringe";
import type { AccountPayableCategory } from "@prisma/client";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import type { SortOrder } from "@/shared/pagination/list-query";

import { AccountPayable } from "../../dtos/account-payable-dto";
import {
  businessClockOf,
  withSituation,
  type AccountPayableSituation,
  type AccountPayableStatusGroup,
  type BusinessClock,
} from "../../rules/account-payable-status";
import {
  summarizeAccountPayableList,
  type AccountPayableListSearchMeta,
  type AccountPayableSortKey,
} from "./account-payable-list";

interface ListAccountPayableRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  statusGroups?: AccountPayableStatusGroup[];
  categories?: AccountPayableCategory[];
  sort?: AccountPayableSortKey;
  order?: SortOrder;
}

interface ListAccountPayableResponse {
  data: Array<AccountPayable & AccountPayableSituation>;
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and the status options. */
  searchMeta: AccountPayableListSearchMeta;
}

/**
 * The company and its "today", for the list and the export alike: the
 * MASTER names the company (there is no all-companies list any more — it
 * mixed tenants on one page), everyone else reads their own.
 */
async function resolveListScope(
  users: IUserRepository,
  businesses: IBusinessRepository,
  userId: string,
  businessId: string | undefined,
): Promise<{ businessId: string; clock: BusinessClock }> {
  const findUser = await users.findUserById(userId);

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

  const business = await businesses.findBusinessById(resolvedBusinessId);

  if (!business) {
    throw new AppError("Empresa não encontrada!", 404, "TENANT_NOT_FOUND");
  }

  return { businessId: resolvedBusinessId, clock: businessClockOf(business) };
}

/**
 * One company's bills. The status of each row, the cards and the status
 * filter are all decided here by the company's business day (decision 8.4),
 * over the whole company — never over the loaded page (decision 8.8).
 */
@injectable()
class ListAccountPayableUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    statusGroups,
    categories,
    sort,
    order,
  }: ListAccountPayableRequest): Promise<ListAccountPayableResponse> {
    const scope = await resolveListScope(
      this.user,
      this.business,
      userId,
      businessId,
    );

    try {
      const result = await this.accountPayable.listAccountPayables({
        page,
        pageSize,
        businessId: scope.businessId,
        clock: scope.clock,
        search,
        statusGroups,
        categories,
        sort,
        order,
      });

      const { total, searchMeta } = summarizeAccountPayableList(result.groups, {
        statusGroups,
      });

      return {
        data: result.data.map((bill) => withSituation(bill, scope.clock)),
        total,
        searchMeta,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar as contas a pagar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListAccountPayableUseCase, resolveListScope };
export type { ListAccountPayableRequest, ListAccountPayableResponse };
