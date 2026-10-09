import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";

import type { SortOrder } from "@/shared/pagination/list-query";

import type { DriverListRow } from "../../dtos/driver-dto";
import { cnhValidity, type CnhValidity } from "../../driver-rules";

import {
  summarizeDriverList,
  type CnhCategoryFacet,
  type DriverContractType,
  type DriverListSearchMeta,
  type DriverSortKey,
  type DriverStatus,
} from "./driver-list";

interface ListDriverRequest {
  userId: string;
  /** MASTER picks the company; everyone else is pinned to their own. */
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: DriverSortKey;
  order?: SortOrder;
  statuses?: DriverStatus[];
  contractTypes?: DriverContractType[];
  cnhCategories?: CnhCategoryFacet[];
  branchIds?: string[];
}

type DriverListItem = DriverListRow & {
  /** Where the CNH stands on the company's business day; null without a date. */
  cnh_status: CnhValidity | null;
};

interface ListDriverResponse {
  data: DriverListItem[];
  /** Rows of search + every filter: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and filter options. */
  searchMeta: DriverListSearchMeta;
}

/**
 * One company's drivers, with sorting, filters and cards answered over the
 * whole company, never over the page on screen (decision 8.8).
 *
 * The MASTER used to get every carrier's drivers mixed in one list; the
 * /admin screen now asks for one company, like every other back-office list.
 */
@injectable()
class ListDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
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
    statuses,
    contractTypes,
    cnhCategories,
    branchIds,
  }: ListDriverRequest): Promise<ListDriverResponse> {
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

    const findBusiness = await this.business.findBusinessById(resolvedBusinessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.driver.listDrivers({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        search,
        statuses,
        contractTypes,
        cnhCategories,
        branchIds,
      });

      const { total, searchMeta } = summarizeDriverList(
        result.groups,
        { statuses, contractTypes, cnhCategories, branchIds },
        result.branchNames,
      );

      // "Vencida" is a fact about the company's day, not the server's.
      const today = businessDateKey(
        new Date(),
        resolveTimeZone(findBusiness.timezone),
      );

      const data = result.data.map((driver) => ({
        ...driver,
        cnh_status: cnhValidity(driver.cnh_expires_at, today),
      }));

      return { data, total, searchMeta };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar listar os motoristas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListDriverUseCase };
export type { ListDriverRequest, ListDriverResponse, DriverListItem };
