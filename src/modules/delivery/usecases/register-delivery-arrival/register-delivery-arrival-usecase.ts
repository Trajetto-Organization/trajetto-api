import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import database from "@/../infra/database";

import { NotificationService } from "@/shared/services/notification-service";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { DeliveryNotFoundError } from "../errors/delivery-errors";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { arrivalStopOutcome } from "@/shared/route/route-rules";
import { announceStopSettled } from "@/shared/route/route-realtime";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { announceRouteClosed } from "@/shared/integration/announce";

import { AppError } from "@/shared/errors/AppError";
import { isUniqueViolation } from "@/shared/http/idempotency-key";

interface RegisterDeliveryArrivalRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  client_submission_id: string;
  latitude: number;
  longitude: number;

  /**
   * When the driver tapped "cheguei", for an arrival the app sent later
   * (resolveOccurredAt). Absent means now.
   */
  occurredAt?: Date | null;
}

/**
 * The driver arrived at the address: an ARRIVAL event with geolocation on
 * an IN_TRANSIT delivery. Events, not columns, because a redelivery attempt
 * legitimately produces a second arrival and the trail keeps both.
 * Idempotent by client_submission_id — an outbox resend is a no-op.
 */
@injectable()
class RegisterDeliveryArrivalUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    client_submission_id,
    latitude,
    longitude,
    occurredAt,
  }: RegisterDeliveryArrivalRequest): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Esta rota é do aplicativo do motorista: apenas usuários vinculados a um motorista registram chegada.",
        403,
        "DRIVER_ONLY",
      );
    }

    // Outbox resend: the same submission never becomes a second event.
    const alreadyRecorded = await this.delivery.findEventBySubmissionId(
      client_submission_id,
      businessId,
    );

    if (alreadyRecorded) {
      return;
    }

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    // Another company's delivery answers exactly like a missing one
    // (decision 11.3): a separate "not yours" told a driver token which ids
    // exist at other carriers.
    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    // Drivers only report on their own deliveries.
    if (findDelivery.driverId !== findUser.driverId) {
      throw new DeliveryNotFoundError();
    }

    if (findDelivery.status !== "IN_TRANSIT") {
      throw new AppError(
        "A chegada só pode ser registrada com a entrega em rota. Inicie a rota no aplicativo antes.",
        400,
        "DELIVERY_NOT_IN_TRANSIT",
      );
    }

    try {
      // Captured to be announced AFTER the commit: a socket event about a
      // write that rolled back is a lie the client cannot undo.
      let settled: Awaited<
        ReturnType<IRouteRepository["settleStopForDelivery"]>
      > = null;

      // The moment of the tap when the app queued it in a dead zone, not the
      // moment the signal came back (MOB-08).
      const arrivedAt = occurredAt ?? new Date();

      // Event and stop commit together. The stop is the route's view of this
      // same act, and `settleStopForDelivery` answers null — rather than
      // throwing — when the delivery is not on a running route, which is the
      // ordinary case for a delivery assigned without one.
      await database.$transaction(async (tx) => {
        await this.delivery.createDeliveryEvent(
          {
            type: "ARRIVAL",
            deliveryId,
            reportedById: userId,
            latitude,
            longitude,
            client_submission_id,
            occurred_at: occurredAt ?? null,
          },
          tx,
        );

        settled = await this.route.settleStopForDelivery(
          deliveryId,
          businessId,
          arrivalStopOutcome(arrivedAt),
          tx,
        );

        // An arrival does not resolve a stop, so this never fires today. It is
        // here anyway because `settleStopForDelivery` is what decides, not
        // this file — the day an outcome makes an arrival final, the customers'
        // systems hear about it without anybody remembering to add a line.
        await announceRouteClosed(this.webhooks, businessId, settled, tx);
      });

      // The panel and the control tower are watching this stop.
      announceStopSettled(businessId, settled);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: deliveryId,
        description:
          `Entrega para ${findDelivery.recipient_name}: ` +
          "motorista chegou ao endereço",
        status: DELIVERY_STATUS_LABELS.IN_TRANSIT,
        performedBy: userId,
        businessId,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      // A copy of this submission committed between the replay check and the
      // insert (the outbox flushing the same arrival twice on a flaky
      // network): the unique client_submission_id refused this one, and the
      // twin IS the answer. It used to surface as a 500, which told the
      // driver an arrival that worked had failed.
      if (
        isUniqueViolation(error) &&
        (await this.delivery.findEventBySubmissionId(
          client_submission_id,
          businessId,
        ))
      ) {
        return;
      }

      throw new AppError(
        "Houve um erro ao tentar registrar a chegada! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RegisterDeliveryArrivalUseCase };
