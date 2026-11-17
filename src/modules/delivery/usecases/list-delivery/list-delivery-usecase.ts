import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { DeliveryKind } from "@/shared/delivery/delivery-kind";

import {
  ListDeliveriesResult,
  SkippedListDeliveriesResult,
} from "../../dtos/delivery-dto";

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
import {
  inheritedOpenStops,
  leftOpenStartedBefore,
} from "@/shared/route/route-left-open";

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

  async execute(request: ListDeliveriesRequest): Promise<ListDeliveriesResult> {
    const { findUser, resolvedBusinessId, timeZone, window } =
      await this.scope(request);

    const {
      page,
      pageSize,
      search,
      sort,
      order,
      statuses,
      shipperIds,
      driverIds,
      kinds,
    } = request;

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
        // The tower's rule as one departure instant (H3).
        leftOpenBefore: leftOpenStartedBefore(timeZone, new Date()),
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
          // The note on the "Em Rota" card: "inclui N de rotas abertas desde
          // dd/mm" (H3), the tower's summary of the same thing.
          inherited: inheritedOpenStops(page_.leftOpenRoutes ?? []),
        },
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível recuperar as entregas!", 500);
    }
  }

  /**
   * `facets=skip` (plano-escala F2-30): the same rows as `execute`, under
   * the same scope and period, and nothing counted — no total, no card, no
   * option. A client turning pages under the same filters keeps the counts
   * it already has; the period still says what the rows cover.
   */
  async executePageOnly(
    request: ListDeliveriesRequest,
  ): Promise<SkippedListDeliveriesResult> {
    const { findUser, resolvedBusinessId, window } = await this.scope(request);

    try {
      const page_ = await this.delivery.listDeliveries({
        page: request.page,
        pageSize: request.pageSize,
        sort: request.sort,
        order: request.order,
        businessId: resolvedBusinessId,
        scopeDriverId: findUser.driverId ?? undefined,
        search: request.search,
        statuses: request.statuses,
        shipperIds: request.shipperIds,
        driverIds: request.driverIds,
        kinds: request.kinds,
        createdFrom: window?.start,
        createdTo: window?.end,
        skipFacets: true,
      });

      return {
        data: page_.data,
        meta: {
          facetsSkipped: true,
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

  /** Who asks, for which company, in which zone and period. */
  private async scope({
    userId,
    businessId,
    period,
    from,
    to,
  }: ListDeliveriesRequest) {
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

    // "Hoje" is the company's day (decision 1.1): the period's days and,
    // since H3, the routes left open that the "Em Rota" card inherits from
    // (decision D26) are both read in the company's zone.
    const timeZone = await loadBusinessTimeZone(
      this.business,
      resolvedBusinessId,
    );

    const window = period
      ? deliveryPeriodWindow({ period, from, to }, timeZone)
      : null;

    return { findUser, resolvedBusinessId, timeZone, window };
  }
}

export { ListDeliveryUseCase };
