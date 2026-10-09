import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { AppError } from "@/shared/errors/AppError";

interface StartDriverRouteRequest {
  userId: string;
  businessId: string;

  /**
   * When the driver tapped "iniciar rota" (resolveOccurredAt). Absent on
   * every build before MOB-08. Not a timestamp to write — a loose departure
   * has no started_at — but the bound of what the tap may move: only loose
   * deliveries that existed when it was made (see `execute`).
   */
  occurredAt?: Date | null;

  /**
   * The request carried a tap older than the offline horizon
   * (isOccurredAtStale). occurredAt is null then, like for no tap at all.
   */
  staleTap?: boolean;
}

interface StartDriverRouteResult {
  started: number;
}

/**
 * The departure, as the driver's app has always asked for it.
 *
 * This endpoint stays for the deliveries that have no route: phones in the
 * field may have queued submissions pointing at it, and deleting it would
 * turn collected work into permanent failures on drivers' screens.
 *
 * Two dispatch models coexist, and this is the old one only:
 *
 *  - A route leaves through `POST /route/start-route/:routeId`, which the app
 *    calls whenever it shows a route. This endpoint never starts one — see
 *    the note in `execute` (IDEMP-17).
 *
 *  - Deliveries assigned in a batch before routes existed move here, as they
 *    always did — never one that belongs to a route (NOT_ON_A_ROUTE in the
 *    repository). Without that filter this tap would drag a plan onto the
 *    street.
 *
 * Idempotent: a resend finds nothing left to move and succeeds with
 * started = 0.
 *
 * On the legacy path a load never leaves with no vehicle behind it. That is a
 * stricter rule than the rest of the platform applies: the other vehicle
 * guards ask "is THIS vehicle yours", which only bites once one was chosen,
 * and here there is nothing to choose from yet. An operation running a shared
 * pool would be refused by it. Choosing the vehicle at departure is the real
 * answer, and it is what the route path does.
 */
@injectable()
class StartDriverRouteUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    occurredAt,
    staleTap = false,
  }: StartDriverRouteRequest): Promise<StartDriverRouteResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Esta rota é do aplicativo do motorista: apenas usuários vinculados a um motorista podem iniciar a rota.",
        403,
        "DRIVER_ONLY",
      );
    }

    /**
     * No route is ever started from here (IDEMP-17).
     *
     * This endpoint used to look up "the driver's route" at the moment the
     * request RAN and start whatever it found. But the app calls it only when
     * none of the deliveries it shows is on a route — so a route found here is
     * one the tap never saw: released after the list was cached, or after a
     * tap queued offline (up to seven days). Starting it put that load "on
     * the street" — "saiu para entrega" to every customer, route.started to
     * every integration — with the truck still in the yard, and left behind
     * the loose deliveries the driver was actually looking at. (MOB-08's
     * stale-tap check narrowed it to taps older than the route; this closes
     * it.) A route leaves through POST /route/start-route/:routeId, which the
     * app calls whenever it shows one; the next refresh shows it.
     *
     * So: loose deliveries only (NOT_ON_A_ROUTE in the repository). A driver
     * with nothing loose gets started = 0 — which is also the resend.
     */

    /**
     * A late replay acts only on what the tap could have seen (MOB-08).
     *
     * The batch is picked when the request RUNS, so a tap queued offline and
     * sent hours later took along every loose delivery designated since —
     * documents the phone never showed, still in the warehouse, "Em rota" on
     * the panel. The route path cannot do this: the tap names its route, and
     * it is never dated before the route existed. Same rule here: nothing
     * created after the tap moves, and a tap older than the offline horizon
     * (seven days) moves nothing at all — a week-old "start my day" is not a
     * command about today. Both answer success, so the outbox lets the item
     * go; the driver's next "Iniciar rota" takes what is left.
     *
     * A build that sends no time keeps moving the whole batch, as before.
     * What this cannot see: a delivery created before the tap but designated
     * to the driver after it — there is no assignment timestamp to bound by.
     */
    if (staleTap) {
      return { started: 0 };
    }

    const createdUpTo = occurredAt ?? undefined;

    // The vehicle guard below belongs to the DEPARTURE, so nothing that is not
    // a departure may reach it. An outbox resend of a route that already left
    // has nothing to move, and making it re-prove the vehicle link hours later
    // turns a harmless duplicate into a permanent red failure on the driver's
    // screen — over a route that did leave. The docblock promised a resend is
    // inoffensive; this is what keeps that promise true.
    const stillWaiting = await this.delivery.countPendingForDriver(
      businessId,
      findUser.driverId,
      createdUpTo,
    );

    if (stillWaiting === 0) {
      return { started: 0 };
    }

    // Deliberately the same predicate the app's vehicle screen already uses:
    // searchVehicleWithCursor serves only ACTIVE and IN_ROUTE vehicles of this
    // driver. Reusing it means the block and the "aguardando veículos" state
    // cannot disagree — if the driver can see a vehicle there the route starts,
    // and if that screen is empty it does not. A second, hand-written criterion
    // here would drift from the screen the driver is actually looking at.
    const { data: driverVehicles } = await this.vehicle.searchVehicleWithCursor({
      limit: 1,
      businessId,
      driverId: findUser.driverId,
    });

    if (driverVehicles.length === 0) {
      // Kept short deliberately: the app shows this in a toast, and a long
      // sentence is ellipsised at one line — losing exactly the half that
      // tells the driver what to do about it.
      throw new AppError(
        "Nenhum veículo vinculado ao seu perfil. Fale com o despachante.",
        403,
        "DRIVER_WITHOUT_VEHICLE",
      );
    }

    try {
      const started = await this.delivery.startDriverRoute(
        businessId,
        findUser.driverId,
        createdUpTo,
      );

      if (started > 0) {
        const plural = started > 1 ? "s" : "";

        // Process activity asynchronously without blocking the main flow
        this.notificationService.createActivityIfEnabled({
          type: "Entrega",
          action: "update",
          entityId: findUser.driverId,
          description:
            `Motorista ${findUser.name} iniciou a rota ` +
            `(${started} entrega${plural})`,
          status: DELIVERY_STATUS_LABELS.IN_TRANSIT,
          performedBy: userId,
          businessId,
        });
      }

      return { started };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar iniciar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { StartDriverRouteUseCase };
