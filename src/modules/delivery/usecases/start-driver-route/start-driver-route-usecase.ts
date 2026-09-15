import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import { StartRouteUseCase } from "@/modules/route/usecases/start-route/start-route-usecase";
import { isStopOpen } from "@/shared/route/route-rules";

import { NotificationService } from "@/shared/services/notification-service";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { AppError } from "@/shared/errors/AppError";

interface StartDriverRouteRequest {
  userId: string;
  businessId: string;
}

interface StartDriverRouteResult {
  started: number;
}

/**
 * The departure, as the driver's app has always asked for it.
 *
 * This endpoint is now an ADAPTER, and stays one deliberately: phones in the
 * field have queued submissions pointing at it, some of them from before the
 * route existed, and deleting it would turn a day of collected work into
 * permanent failures on drivers' screens. The app can migrate to
 * `POST /routes/:routeId/start` at its own pace.
 *
 * Two dispatch models coexist while that happens, so the order below matters:
 *
 *  - The driver has a route. It is the thing that starts; delegating to
 *    start-route gets the stop bookkeeping, the vehicle swap, the R6 index and
 *    the mirroring for free, and there is exactly one departure in the system.
 *
 *  - The driver has no route, only deliveries assigned in a batch. The old
 *    path, unchanged — except that it can no longer touch a delivery which
 *    belongs to a route (see NOT_ON_A_ROUTE in the repository). Without that
 *    filter this tap would drag an unreleased plan onto the street.
 *
 * Idempotent either way: a resend finds the route already IN_PROGRESS, or
 * finds nothing left to move, and succeeds with started = 0.
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
    @inject("RouteRepository")
    private route: IRouteRepository,
    private startRoute: StartRouteUseCase,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
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

    // The route comes first, and before the "nothing to do" check below: a
    // driver whose whole day is one released route has no loose PENDING
    // deliveries at all, so that check would answer "nothing to start" over a
    // route sitting right there waiting to leave.
    const findRoute = await this.route.findDriverRoute(
      businessId,
      findUser.driverId,
    );

    if (findRoute) {
      // Already out. This is the resend, and it must not be an error: the app
      // classifies a 4xx as permanent and would park a departure that did
      // happen on the pending screen.
      if (findRoute.status === "IN_PROGRESS") {
        return { started: 0 };
      }

      await this.startRoute.execute({
        userId,
        businessId,
        routeId: findRoute.id,
      });

      // What the app shows on the toast: how many addresses it just took on.
      return {
        started: findRoute.stops.filter((stop) => isStopOpen(stop.status))
          .length,
      };
    }

    // The vehicle guard below belongs to the DEPARTURE, so nothing that is not
    // a departure may reach it. An outbox resend of a route that already left
    // has nothing to move, and making it re-prove the vehicle link hours later
    // turns a harmless duplicate into a permanent red failure on the driver's
    // screen — over a route that did leave. The docblock promised a resend is
    // inoffensive; this is what keeps that promise true.
    const stillWaiting = await this.delivery.countPendingForDriver(
      businessId,
      findUser.driverId,
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
