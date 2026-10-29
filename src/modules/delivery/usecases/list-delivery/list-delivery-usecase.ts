import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { DeliveryKind } from "@/shared/delivery/delivery-kind";

import { ListDeliveriesResult } from "../../dtos/delivery-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import type { SortOrder } from "@/shared/pagination/list-query";
import {
  loadBusinessTimeZone,
  type BusinessLookup,
} from "@/shared/time/business-time-zone";
import {
  summarizeDeliveryList,
  DeliverySortKey,
} from "@/modules/delivery/usecases/list-delivery/delivery-list";
import {
  deliveryPeriodWindow,
  type DeliveryPeriodInput,
} from "@/modules/delivery/usecases/list-delivery/delivery-period";

interface ListDeliveriesRequest extends DeliveryPeriodInput {
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
  kinds?: DeliveryKind[];
}

@injectable()
class ListDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("BusinessRepository")
    private business: BusinessLookup,
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
    kinds,
    period,
    from,
    to,
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

    // "Hoje" is the company's day (decision 1.1), so the zone is read only
    // when a period was asked for: without one the listing never needed it.
    const window = period
      ? deliveryPeriodWindow(
          { period, from, to },
          await loadBusinessTimeZone(this.business, resolvedBusinessId),
        )
      : null;

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
        kinds,
        createdFrom: window?.start,
        createdTo: window?.end,
      });

      // The cards and the filter counts come from the whole set, never from
      // the loaded page (decision 8.8); the pager total is derived from them.
      const { total, searchMeta } = summarizeDeliveryList(
        page_.statusCounts,
        { statuses },
        { shippers: page_.shipperOptions, drivers: page_.driverOptions },
      );

      return {
        data: page_.data,
        total,
        meta: {
          ...searchMeta,
          period: window
            ? { from: window.from, to: window.to, applied: page_.periodApplied }
            : null,
        },
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar as entregas!", 500);
    }
  }
}

export { ListDeliveryUseCase };
