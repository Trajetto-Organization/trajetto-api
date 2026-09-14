import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryStatusConflictError,
} from "../errors/delivery-errors";

import {
  canTransitionDelivery,
  DeliveryStatus,
  DELIVERY_STATUS_LABELS,
} from "@/shared/delivery/delivery-rules";

import { AppError } from "@/shared/errors/AppError";
import { Delivery } from "../../dtos/delivery-dto";

interface UpdateDeliveryStatusRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  status: DeliveryStatus;
  received_by?: string;
}

@injectable()
class UpdateDeliveryStatusUseCase {
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
    status,
    received_by,
  }: UpdateDeliveryStatusRequest): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    if (!findDelivery) {
      throw new DeliveryNotFoundError();
    }

    if (findDelivery.businessId !== businessId) {
      throw new DeliveryNotBelongBusinessError();
    }

    // Drivers only move their own deliveries.
    if (findUser.driverId && findDelivery.driverId !== findUser.driverId) {
      throw new DeliveryNotFoundError();
    }

    const verdict = canTransitionDelivery(findDelivery.status, status);

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_STATUS_TRANSITION");
    }

    try {
      const updatedDelivery = await this.delivery.updateDeliveryStatus(
        deliveryId,
        {
          status,
          // What canTransitionDelivery was asked about, three lines up. The
          // write refuses if the row no longer holds it.
          expectedStatus: findDelivery.status,
          // Proof metadata only exists on the proven outcome.
          delivered_at: status === "DELIVERED" ? new Date() : null,
          received_by: status === "DELIVERED" ? (received_by ?? null) : null,
        },
      );

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: deliveryId,
        description:
          `Entrega para ${findDelivery.recipient_name}: ` +
          `${DELIVERY_STATUS_LABELS[findDelivery.status]} → ${DELIVERY_STATUS_LABELS[status]}`,
        status: DELIVERY_STATUS_LABELS[status],
        performedBy: userId,
        businessId,
      });

      return updatedDelivery;
    } catch (error) {
      // 409, not 500: the request was well formed and the caller was allowed
      // to make it — somebody else simply got there first. The screen has to
      // be able to tell the operator to refresh, not to try again.
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar mudar o status da entrega! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateDeliveryStatusUseCase };
