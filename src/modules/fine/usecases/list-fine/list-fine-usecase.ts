import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IFineRepository } from "../../repositories/IFine-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import { businessDayRange } from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";

import type { Fine } from "../../dtos/fine-dto";
import { fineDays } from "../fine-dates";

import {
  summarizeFineList,
  type FineListSearchMeta,
  type FineSortKey,
  type FineStatus,
} from "./fine-list";

interface ListFineRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  statuses?: FineStatus[];
  branchIds?: string[];
  trafficViolationCodeIds?: string[];
  sort?: FineSortKey;
  order?: SortOrder;
  now?: Date;
}

interface ListFineResponse {
  data: Fine[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: FineListSearchMeta;
}

/**
 * One company's fines, ordered, filtered and counted by the server over the
 * whole company (decision 8.8). The cards used to count "Pagas" and
 * "Pendentes" over the ten rows on screen, and the MASTER got every
 * company's fines in one list; now the MASTER names the company and
 * everyone else is pinned to their own.
 *
 * "Vencida" is decided here, once, on the company's business day: the same
 * line draws the row badge, the filter and the cards. The dates go out as
 * that day's keys too (`violation_day`, `due_day`, `payment_day`).
 */
@injectable()
class ListFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
  ) {}

  async execute({
    userId,
    businessId,
    page,
    pageSize,
    search,
    statuses,
    branchIds,
    trafficViolationCodeIds,
    sort,
    order,
    now = new Date(),
  }: ListFineRequest): Promise<ListFineResponse> {
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

    const timeZone = await loadBusinessTimeZone(this.business, resolvedBusinessId);
    const { start: todayStart } = businessDayRange(now, timeZone);

    const facets = { statuses, branchIds, trafficViolationCodeIds };

    try {
      const result = await this.fine.listFines({
        page,
        pageSize,
        sort,
        order,
        todayStart,
        businessId: resolvedBusinessId,
        search,
        ...facets,
      });

      const { total, searchMeta } = summarizeFineList(
        result.groups,
        result.labels,
        facets,
      );

      // Each date also as the day it is in the company's zone: the screens
      // show that day, never the instant read in the viewer's zone.
      const data = result.data.map((fine) => ({ ...fine, ...fineDays(fine, timeZone) }));

      return { data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar as multas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFineUseCase };
export type { ListFineRequest, ListFineResponse };
