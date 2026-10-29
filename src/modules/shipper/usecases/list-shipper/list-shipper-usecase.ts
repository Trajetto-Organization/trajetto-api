import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IShipperRepository } from "../../repositories/IShipper-repository";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";
import type { ActiveStatus } from "@/shared/delivery/catalog-list";

import { ListShippersResult } from "../../dtos/shipper-dto";
import { summarizeShipperList, type ShipperSortKey } from "./shipper-list";

interface ListShippersRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: ShipperSortKey;
  order?: SortOrder;
  statuses?: ActiveStatus[];
}

@injectable()
class ListShipperUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
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
  }: ListShippersRequest): Promise<ListShippersResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // MASTER picks the company explicitly; everyone else is pinned to
    // their own — same resolution every list route in the app uses.
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
      const { data, groups } = await this.shipper.listShippers({
        page,
        pageSize,
        businessId: resolvedBusinessId,
        search,
        sort,
        order,
        statuses,
      });

      // Cards and filter counts over the whole company (decision 8.8),
      // never the page on screen.
      const { total, searchMeta } = summarizeShipperList(groups, { statuses });

      return { data, total, meta: searchMeta };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar os embarcadores!", 500);
    }
  }
}

export { ListShipperUseCase };
