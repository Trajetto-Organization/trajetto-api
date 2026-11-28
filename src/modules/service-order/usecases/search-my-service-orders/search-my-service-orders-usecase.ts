import { inject, injectable } from "tsyringe";

import { IServiceOrderRepository } from "../../repositories/IService-order-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import type { DriverServiceOrderScope } from "../../dtos/service-order-dto";
import {
  toServiceOrderDriverView,
  type ServiceOrderDriverView,
} from "../service-order-views";

interface SearchMyServiceOrdersRequest {
  userId: string;
  scope: DriverServiceOrderScope;
  limit?: number;
  cursor?: string;
}

interface SearchMyServiceOrdersResponse {
  data: ServiceOrderDriverView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * "Minhas OS" (wave 3, owner's decision): the driver's two sections, each
 * with its own cursor, newest first.
 *
 * - `assigned`: the orders whose responsible is the caller — the ones the
 *   notification announces. The vehicle history could not show them when
 *   the truck was another driver's.
 * - `vehicle`: the orders of every vehicle the driver may operate
 *   (canDriverOperateVehicle as a list: the responsible driver and the
 *   substitute of a released or running route), minus the caller's own, so
 *   an order never shows in both sections.
 *
 * A driver login only (403 DRIVER_ONLY otherwise): the company's lists are
 * the office's. User and company come from the session, never the request.
 * Always the view without money (service-order-views.ts): this streams as
 * NDJSON and no response schema filters it on the way out.
 */
@injectable()
class SearchMyServiceOrdersUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
  ) {}

  async execute({
    userId,
    scope,
    limit = 10,
    cursor,
  }: SearchMyServiceOrdersRequest): Promise<SearchMyServiceOrdersResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId || !findUser.businessId) {
      throw new AppError(
        "Esta lista é do aplicativo do motorista: apenas usuários vinculados a um motorista têm ordens de serviço próprias.",
        403,
        "DRIVER_ONLY",
      );
    }

    const businessId = findUser.businessId;

    const vehicleIds =
      scope === "vehicle"
        ? await this.vehicle.findDriverOperableVehicleIds({
            driverId: findUser.driverId,
            businessId,
          })
        : [];

    const page = await this.serviceOrder.searchServiceOrdersOfDriverWithCursor({
      limit,
      cursor,
      businessId,
      userId,
      scope,
      vehicleIds,
    });

    return {
      data: page.data.map(toServiceOrderDriverView),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}

export { SearchMyServiceOrdersUseCase };
