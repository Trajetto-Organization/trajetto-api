import { inject, injectable } from "tsyringe";

import { IServiceOrderRepository } from "../../repositories/IService-order-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";

import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";
import { resolveRequestedCompany } from "@/modules/middlewares/tenant-authorization";

import {
  toServiceOrderDriverView,
  toServiceOrderFullView,
  type ServiceOrderRead,
} from "../service-order-views";

interface GetServiceOrderRequest {
  userId: string;
  serviceOrderId: string;
  /** The MASTER's selected company; anyone else reads their own. */
  businessId?: string;
}

/**
 * One service order by its id (wave 3): what a notification opens in the
 * app. There was no read by id at all, only listings that recompute the
 * whole company's cards on every request.
 *
 * The listings' authorization: the company's admin, a profile with
 * `service_order_manage:read`, the MASTER in the company he selected, and a
 * driver login only for an order he is responsible for or of a vehicle he
 * may operate (canDriverOperateVehicle: the substitute of a released route
 * included). The responsible branch is what the notification needed: the
 * order is announced to its responsible, and a driver responsible for
 * another truck's order used to get a 403 from the vehicle history.
 *
 * Everything out of reach answers 404 SERVICE_ORDER_NOT_FOUND, the body of
 * an id that exists nowhere, so an id cannot be probed (decision 11.3). The
 * driver gets the view without money (service-order-views.ts).
 */
@injectable()
class GetServiceOrderUseCase {
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
    serviceOrderId,
    businessId,
  }: GetServiceOrderRequest): Promise<ServiceOrderRead> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The route's guard, restated for any caller of the use case.
    const refusal = decidePermission(
      findUser as unknown as PermissionPrincipal,
      "service_order_manage",
      "read",
    );

    if (refusal) throw refusal;

    const companyId = resolveRequestedCompany(findUser, businessId);

    const order = await this.serviceOrder.findServiceOrderDetail(
      serviceOrderId,
      companyId,
    );

    if (!order) {
      throw new ServiceOrderNotFoundError();
    }

    if (findUser.driverId) {
      const reachable =
        order.responsibleUserId === findUser.id ||
        (await this.vehicle.canDriverOperateVehicle({
          vehicleId: order.vehicleId,
          driverId: findUser.driverId,
          businessId: companyId,
        }));

      if (!reachable) {
        throw new ServiceOrderNotFoundError();
      }

      return { view: "driver", serviceOrder: toServiceOrderDriverView(order) };
    }

    return { view: "full", serviceOrder: toServiceOrderFullView(order) };
  }
}

export { GetServiceOrderUseCase };
