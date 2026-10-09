import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { DeliveryStatus } from "@/shared/delivery/delivery-rules";

import { ListDeliveriesResult } from "../../dtos/delivery-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import type { SortOrder } from "@/shared/pagination/list-query";
import {
  summarizeDeliveryList,
  DeliverySortKey,
} from "@/modules/delivery/usecases/list-delivery/delivery-list";

interface ListDeliveriesRequest {
  userId: string;
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: DeliverySortKey;
  order?: SortOrder;
  statuses?: DeliveryStatus[];
  shipperIds?: string[];
  driverIds?: string[];
}

@injectable()
class ListDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
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
    shipperIds,
    driverIds,
  }: ListDeliveriesRequest): Promise<ListDeliveriesResult> {
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
      // Drivers only see what they carry — the app never lists the whole
      // operation to the person executing one slice of it. A scope, not a
      // facet: the driver filter of the screen cannot widen it.
      const page_ = await this.delivery.listDeliveries({
        page,
        pageSize,
        sort,
        order,
        businessId: resolvedBusinessId,
        scopeDriverId: findUser.driverId ?? undefined,
        search,
        statuses,
        shipperIds,
        driverIds,
      });

      // The cards and the filter counts come from the whole set, never from
      // the loaded page (decision 8.8); the pager total is derived from them.
      const { total, searchMeta } = summarizeDeliveryList(
        page_.statusCounts,
        { statuses },
        { shippers: page_.shipperOptions, drivers: page_.driverOptions },
      );

      return { data: page_.data, total, meta: searchMeta };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar as entregas!", 500);
    }
  }
}

export { ListDeliveryUseCase };
