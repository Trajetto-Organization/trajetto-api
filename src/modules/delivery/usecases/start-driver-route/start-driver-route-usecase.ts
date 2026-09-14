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
}

interface StartDriverRouteResult {
  started: number;
}

/**
 * One tap in the app moves every delivery designated to the driver from
 * PENDING to IN_TRANSIT — the dispatch reality is that the load leaves as a
 * block. Naturally idempotent: an outbox resend finds nothing left to move
 * and succeeds with started = 0.
 *
 * A load never leaves with no vehicle behind it. Note this is a stricter rule
 * than the rest of the platform applies today: the other five vehicle guards
 * ask "is THIS vehicle yours", which only bites once a vehicle was chosen.
 * Here there is nothing to choose from yet, so the question is whether the
 * driver has one at all — and an operation that runs a shared pool, never
 * linking a vehicle to a driver, would be refused by this. Relaxing it is the
 * `if` below and nothing else. Choosing the vehicle at departure is the real
 * answer and belongs to the route entity, not here.
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
