import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";
import type { ActiveStatus } from "@/shared/delivery/catalog-list";

import { ListStatusChangeReasonsResult } from "../../dtos/status-change-reason-dto";
import {
  summarizeStatusReasonList,
  type StatusReasonSortKey,
} from "./status-change-reason-list";

interface ListStatusChangeReasonsRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: StatusReasonSortKey;
  order?: SortOrder;
  statuses?: ActiveStatus[];
}

@injectable()
class ListStatusChangeReasonUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    sort,
    order,
    statuses,
  }: ListStatusChangeReasonsRequest): Promise<ListStatusChangeReasonsResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // MASTER picks the company explicitly; everyone else is pinned to their
    // own — the same resolution every list route in the app uses.
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
      const { data, groups, used } = await this.reason.listStatusChangeReasons({
        page,
        pageSize,
        businessId: resolvedBusinessId,
        search,
        sort,
        order,
        statuses,
      });

      // The cards and the filter counts describe the whole catalogue
      // (decision 8.8), never the page on screen.
      const { total, searchMeta } = summarizeStatusReasonList(groups, used, {
        statuses,
      });

      return { data, total, meta: searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar os motivos! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListStatusChangeReasonUseCase };
