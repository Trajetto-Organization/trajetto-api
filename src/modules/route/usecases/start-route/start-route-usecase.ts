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

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { routeEventPayload } from "@/shared/integration/announce";

import { canTransitionRoute, isStopOpen } from "@/shared/route/route-rules";
import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import {
  RouteDriverBusyError,
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

  /**
   * When the driver tapped "iniciar rota", for a departure the app sent later
   * (resolveOccurredAt). Absent means now.
   */
  occurredAt?: Date | null;
}

/**
 * The departure. This is what "iniciar rota" becomes.
 *
 * It replaces the old `start-driver-route`, which was a verb with no noun
 * behind it: an updateMany moving every PENDING delivery of a driver to
 * IN_TRANSIT, with nothing to consult afterwards. The route is the thing that
 * starts; the deliveries follow from it.
 *
 * Idempotent for the offline queue, and that had to be made true rather than
 * asserted. A resend finds the route already IN_PROGRESS and now gets the
 * route back with a 200 — see the check below. It used to get a 409, which is
 * the correct answer to a person pressing the button twice and the WRONG one
 * to a queue: the app's outbox reads a non-transient 4xx as the API refusing
 * on the merits and marks the submission `failed`, so a departure that
 * actually happened in a dead zone showed up on the driver's phone as an
 * error they could do nothing about.
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
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    vehicleId,
    occurredAt,
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
      throw new RouteNotFoundError();
    }

    /**
     * The resend, answered as success rather than as a conflict.
     *
     * Only when nothing would change: no vehicle asked for, or the same one
     * the route already left with. A second departure naming a DIFFERENT
     * truck is a real conflict — somebody swapped vehicles after the route
     * was already on the street — and it still refuses below.
     *
     * This is what makes the offline queue safe. The app sends the departure
     * through the same outbox as everything else, and an outbox resends after
     * a dead network: without this, the second attempt is a 4xx, the item is
     * marked `failed`, and the driver is shown an error for something that
     * worked.
     */
    if (
      findRoute.status === "IN_PROGRESS" &&
      (!vehicleId || vehicleId === findRoute.vehicleId)
    ) {
      return findRoute;
    }

    // The same resend, arriving after the route already finished — the day's
    // last proof closed it, or the dispatcher cancelled it on the road, while
    // the departure's first answer was lost. The departure DID happen
    // (started_at says so), so the resend is answered as the success it is;
    // a 400 here parked a departure that worked as a permanent failure on the
    // driver's phone. A route cancelled BEFORE it left has no started_at and
    // is still refused below.
    if (
      (findRoute.status === "COMPLETED" || findRoute.status === "CANCELLED") &&
      findRoute.started_at &&
      (!vehicleId || vehicleId === findRoute.vehicleId)
    ) {
      return findRoute;
    }

    const verdict = canTransitionRoute(findRoute.status, "IN_PROGRESS");

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_ROUTE_TRANSITION");
    }

    // Nothing left on it (see routeWithoutStops). Refused here before the
    // vehicle checks, and asked again under the row lock in the transaction.
    if (!findRoute.stops.some((stop) => isStopOpen(stop.status))) {
      throw routeWithoutStops();
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

    // The moment of the tap, for a departure queued in the yard's dead zone
    // (MOB-08) — but never before the route existed: the app only knows a
    // route id it was shown, so an earlier instant is a clock gone wrong, and
    // the receipt is the honest fallback.
    const startedAt =
      occurredAt && occurredAt.getTime() >= findRoute.created_at.getTime()
        ? occurredAt
        : new Date();

    // How many addresses actually left, for the activity line after the
    // commit. Counted from the departure's own read, like the messages.
    let departedCount = 0;

    try {
      // The transition and the "saiu para entrega" messages commit together.
      // A truck that left with the customers never told is the state this
      // exists to prevent, and a route departs once — there is no second
      // chance to publish.
      const started = await database.$transaction(async (tx) => {
        /**
         * One route on the street per driver (FLEET-ASSIGN-3), like one per
         * truck. Releasing tomorrow's route while today's runs stays
         * allowed; leaving with it does not. Under a per-driver lock taken
         * in THIS transaction, so two taps on two released routes queue and
         * the second one sees the first one's departure.
         */
        await this.route.assertDriverFreeToDepart(
          findRoute.driverId,
          businessId,
          routeId,
          tx,
        );

        const moved = await this.route.transitionRoute(
          routeId,
          businessId,
          {
            expectedStatus: findRoute.status,
            status: "IN_PROGRESS",
            vehicleId: departingVehicleId,
            started_at: startedAt,
          },
          tx,
        );

        // The empty-route guard above, asked again now that the UPDATE holds
        // the route row. A stop taken off between that read and this write
        // (removeStop, or a cancellation dropping it from the plan) leaves
        // the status alone, so the conditional UPDATE still matched after
        // waiting for it — and the route left with nothing it could ever
        // resolve. Every composition write locks this row first, so what is
        // read here is what the departure carries. Refused; all of it rolls
        // back.
        const departing = await this.route.findRouteById(
          routeId,
          businessId,
          tx,
        );

        if (!departing?.stops.some((stop) => isStopOpen(stop.status))) {
          throw routeWithoutStops();
        }

        // What left, read AFTER the transition and inside its transaction —
        // not `findRoute.stops`, which was read before the vehicle check and
        // could still carry a stop removed since, or a delivery cancelled
        // while its stop waited. The customers told are the ones whose load
        // this commit put on the street.
        const departed = await this.route.listDepartedDeliveries(
          routeId,
          businessId,
          tx,
        );

        departedCount = departed.length;

        for (const delivery of departed) {
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

        // In the SAME transaction as the departure, for the reason the outbox
        // rows above are: an event queued after the commit is an event a crash
        // in between erases.
        await this.webhooks.announce(
          "route.started",
          businessId,
          routeEventPayload(
            { ...findRoute, status: "IN_PROGRESS", started_at: startedAt },
            startedAt,
          ),
          tx,
        );

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
          `${departedCount} parada${departedCount === 1 ? "" : "s"}`,
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

      // The driver is already out with another route. A real refusal, not a
      // race to paper over: the app shows the sentence as it is.
      if (error instanceof RouteDriverBusyError) {
        throw new AppError(error.message, 409, "ROUTE_DRIVER_BUSY");
      }

      if (error instanceof RouteStatusConflictError) {
        // The resend check above, made again after losing the race. The
        // app's client gives up after 20 s while the first departure is still
        // being written, the outbox resends at once, and both requests read
        // the route before either commits — so the resend misses the early
        // return and loses the status guard instead. If the route is now out
        // with this driver on the truck this request asked for, the departure
        // it wanted happened: success, not a 409 the outbox marks `failed`.
        const current = await this.route.findRouteById(routeId, businessId);

        if (
          current?.status === "IN_PROGRESS" &&
          current.driverId === findUser.driverId &&
          current.vehicleId === departingVehicleId
        ) {
          return current;
        }

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

/**
 * A released route whose stops were all taken off it afterwards. Leaving with
 * it would never end: a route closes when its last open stop resolves, and
 * there is none — IN_PROGRESS forever, the truck "Em rota".
 */
function routeWithoutStops(): AppError {
  return new AppError(
    "Esta rota não tem nenhuma parada para executar. Fale com o despachante.",
    400,
    "ROUTE_WITHOUT_STOPS",
  );
}

export { StartRouteUseCase };
export type { StartRouteRequest };
