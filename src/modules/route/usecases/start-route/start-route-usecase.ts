import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { sendRouteEventToBusiness } from "@/websocket";
import { AppError } from "@/shared/errors/AppError";

import database from "@/../infra/database";

import { OutboxService } from "@/shared/notifications/outbox-service";

import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";

import { canTransitionRoute } from "@/shared/route/route-rules";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import {
  RouteNotFoundError,
  RouteStatusConflictError,
  RouteVehicleBusyError,
  RouteVehicleUnavailableError,
} from "../errors/route-errors";

import type { Route } from "../../dtos/route-dto";

interface StartRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;

  /**
   * The vehicle the driver is actually taking. Absent means "the one already
   * on the route"; a different id is a swap at the yard, which happens often
   * enough that refusing it would send drivers back to the dispatcher.
   */
  vehicleId?: string;
}

/**
 * The departure. This is what "iniciar rota" becomes.
 *
 * It replaces the old `start-driver-route`, which was a verb with no noun
 * behind it: an updateMany moving every PENDING delivery of a driver to
 * IN_TRANSIT, with nothing to consult afterwards. The route is the thing that
 * starts; the deliveries follow from it.
 *
 * Naturally idempotent for the offline queue: a resend finds the route already
 * IN_PROGRESS, the precondition refuses, and the caller gets a conflict rather
 * than a second departure.
 */
@injectable()
class StartRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    vehicleId,
  }: StartRouteRequest): Promise<Route> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser?.driverId) {
      throw new AppError(
        "Apenas motoristas podem iniciar uma rota.",
        403,
        "NOT_A_DRIVER",
      );
    }

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Same answer for "does not exist" and "is not yours": a driver must not
    // be able to learn that a route id is real by being told a different
    // refusal.
    if (!findRoute || findRoute.driverId !== findUser.driverId) {
      throw new AppError(new RouteNotFoundError().message, 404);
    }

    const verdict = canTransitionRoute(findRoute.status, "IN_PROGRESS");

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_ROUTE_TRANSITION");
    }

    const departingVehicleId = vehicleId ?? findRoute.vehicleId;

    // The guard that used to live in start-driver-route, now where it belongs:
    // a route cannot leave without a vehicle, and the route is the thing that
    // has one.
    if (!departingVehicleId) {
      throw new AppError(
        "Esta rota não tem veículo definido. Fale com o despachante.",
        400,
        "ROUTE_WITHOUT_VEHICLE",
      );
    }

    // The vehicle is checked on EVERY departure, not only when the driver
    // swaps it. Between the dispatcher planning the route and the truck
    // leaving the yard there is usually a night, and an administrator can
    // block a vehicle in it — an accident, a theft, an expired licence. The
    // guard used to run only on a swap, so the one case it was written for
    // (a vehicle that must not take cargo) was exactly the one it missed.
    const findVehicle = await this.vehicle.findVehicleById(departingVehicleId);

    if (!findVehicle || findVehicle.businessId !== businessId) {
      throw new AppError("Veículo não encontrado.", 404, "VEHICLE_NOT_FOUND");
    }

    if (isVehicleOutOfOperation(findVehicle.status)) {
      throw new AppError(
        new RouteVehicleUnavailableError().message,
        400,
        "ROUTE_VEHICLE_UNAVAILABLE",
      );
    }

    try {
      // The transition and the "saiu para entrega" messages commit together.
      // A truck that left with the customers never told is the state this
      // exists to prevent, and a route departs once — there is no second
      // chance to publish.
      const started = await database.$transaction(async (tx) => {
        const moved = await this.route.transitionRoute(
          routeId,
          businessId,
          {
            expectedStatus: findRoute.status,
            status: "IN_PROGRESS",
            vehicleId: departingVehicleId,
            started_at: new Date(),
          },
          tx,
        );

        for (const stop of findRoute.stops) {
          const delivery = stop.delivery;

          // Most deliveries carry neither an e-mail nor a phone for the person
          // receiving them. Checked here so no outbox row is written that
          // could only ever expand into nothing — a forty-stop route would
          // otherwise queue forty rows to be claimed, expanded and discarded.
          if (!delivery || !hasSomebodyToTell(delivery)) continue;

          await this.outbox.publish(tx, {
            topic: "delivery.dispatched",
            aggregateType: "delivery",
            aggregateId: delivery.id,
            businessId,
            actorId: userId,
            payload: buildDeliveryCustomerPayload(delivery.id, {
              ...delivery,

              // From the route, which is already scoped, rather than from the
              // stop's select: the delivery of a route is by construction a
              // delivery of that route's company.
              businessId,
            }),
          });
        }

        return moved;
      });

      // The control tower is watching for exactly this. No push: nobody needs
      // to be woken up because a truck left on time.
      sendRouteEventToBusiness(businessId, {
        type: "route.started",
        routeId,
        routeCode: findRoute.code,
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description:
          `Rota ${findRoute.code} iniciada com ` +
          `${findRoute.stops.length} parada${findRoute.stops.length === 1 ? "" : "s"}`,
        status: "Em andamento",
        performedBy: userId,
        businessId,
      });

      return started;
    } catch (error) {
      // The truck is on one road. Raised by the partial unique index, so it
      // holds even against a request this process never validated.
      if (error instanceof RouteVehicleBusyError) {
        throw new AppError(error.message, 409, "ROUTE_VEHICLE_BUSY");
      }

      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar iniciar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { StartRouteUseCase };
export type { StartRouteRequest };
