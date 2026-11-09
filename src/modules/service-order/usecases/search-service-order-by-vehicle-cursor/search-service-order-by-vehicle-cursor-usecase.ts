import { inject, injectable } from "tsyringe";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import type { CursorPaginatedServiceOrderDetail } from "../../dtos/service-order-dto";
import { AppError } from "@/shared/errors/AppError";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

import {
  toServiceOrderDriverView,
  toServiceOrderFullView,
  type ServiceOrderDriverView,
  type ServiceOrderFullView,
} from "../service-order-views";

interface SearchServiceOrderByVehicleCursorRequest {
  userId: string;
  vehicleId: string;
  limit?: number;
  cursor?: string;
}

/** One reader, one view: `view` says which one every line of the page is. */
type SearchServiceOrderByVehicleCursorResponse =
  | {
      view: "driver";
      data: ServiceOrderDriverView[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  | {
      view: "full";
      data: ServiceOrderFullView[];
      nextCursor: string | null;
      hasMore: boolean;
    };

/**
 * A vehicle's service orders, newest first by cursor: the web's driver page
 * (/driver/vehicles/:vehicleId/service-orders) and the office.
 *
 * Each order leaves in its reader's view (wave 3, owner's decision), the
 * one GET /service-order/:serviceOrderId picks by the same test: a driver
 * login gets the view without money — no total, no part price or discount,
 * no supplier — and everyone else the full one. It carried the raw row to
 * the driver, part prices and the workshop included, and it streams as
 * NDJSON, so no response schema filtered anything on the way out.
 */
@injectable()
class SearchServiceOrderByVehicleCursorUseCase {
  constructor(
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    vehicleId,
    limit = 10,
    cursor,
  }: SearchServiceOrderByVehicleCursorRequest): Promise<SearchServiceOrderByVehicleCursorResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    // Verify vehicle belongs to user's business
    if (findVehicle.businessId !== findUser.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // A driver reads the history of a vehicle they may operate: the one they
    // are responsible for, or the one their released or running route uses
    // (FLEET-ASSIGN-1, decision 4.4). Comparing only Vehicle.driverId
    // refused the substitute who took the truck out that morning.
    if (findUser.driverId) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId,
        driverId: findUser.driverId,
        businessId: findVehicle.businessId,
      });

      if (!allowed) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    const findBusiness = await this.business.findBusinessById(
      findUser.businessId as string,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    let page: CursorPaginatedServiceOrderDetail;

    try {
      page = await this.serviceOrder.searchServiceOrderByVehicleWithCursor({
        limit,
        cursor,
        vehicleId,
        businessId: findUser.businessId as string,
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as ordens de serviço do veículo!",
        500,
      );
    }

    const { nextCursor, hasMore } = page;

    // The test the check above and GET /:serviceOrderId use: a login linked
    // to a driver reads as the driver, whatever its role.
    if (findUser.driverId) {
      return {
        view: "driver",
        data: page.data.map(toServiceOrderDriverView),
        nextCursor,
        hasMore,
      };
    }

    return {
      view: "full",
      data: page.data.map(toServiceOrderFullView),
      nextCursor,
      hasMore,
    };
  }
}

export { SearchServiceOrderByVehicleCursorUseCase };
