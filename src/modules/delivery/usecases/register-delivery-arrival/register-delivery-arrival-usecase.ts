import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { AppError } from "@/shared/errors/AppError";

interface RegisterDeliveryArrivalRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  client_submission_id: string;
  latitude: number;
  longitude: number;
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
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    client_submission_id,
    latitude,
    longitude,
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
    const alreadyRecorded =
      await this.delivery.findEventBySubmissionId(client_submission_id);

    if (alreadyRecorded) {
      return;
    }

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    if (!findDelivery) {
      throw new DeliveryNotFoundError();
    }

    if (findDelivery.businessId !== businessId) {
      throw new DeliveryNotBelongBusinessError();
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
      await this.delivery.createDeliveryEvent({
        type: "ARRIVAL",
        deliveryId,
        reportedById: userId,
        latitude,
        longitude,
        client_submission_id,
      });

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

      throw new AppError(
        "Houve um erro ao tentar registrar a chegada! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RegisterDeliveryArrivalUseCase };
