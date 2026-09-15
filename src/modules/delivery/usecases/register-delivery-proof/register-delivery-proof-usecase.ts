import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import database from "@/../infra/database";

import { NotificationService } from "@/shared/services/notification-service";
import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryStatusConflictError,
} from "../errors/delivery-errors";

import {
  canTransitionDelivery,
  DELIVERY_STATUS_LABELS,
} from "@/shared/delivery/delivery-rules";

import { stopOutcomeForDelivery } from "@/shared/route/route-rules";

import { AppError } from "@/shared/errors/AppError";

interface RegisterDeliveryProofRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  client_submission_id: string;
  photo: string;
  signature?: string;
  received_by?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Proof of delivery: the receipt photo (and optional on-screen signature)
 * went straight to the bucket via presigned PUT — here only ownership and
 * existence of the keys are checked before the PROOF event and the
 * DELIVERED stamp land in one transaction. Idempotent by
 * client_submission_id: an outbox resend after a dead network is a no-op.
 */
@injectable()
class RegisterDeliveryProofUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    client_submission_id,
    photo,
    signature,
    received_by,
    latitude,
    longitude,
  }: RegisterDeliveryProofRequest): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Esta rota é do aplicativo do motorista: apenas usuários vinculados a um motorista comprovam entregas.",
        403,
        "DRIVER_ONLY",
      );
    }

    // Outbox resend: the same submission never becomes a second proof, and
    // the delivery it proved is already DELIVERED.
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

    // Drivers only prove their own deliveries.
    if (findDelivery.driverId !== findUser.driverId) {
      throw new DeliveryNotFoundError();
    }

    const verdict = canTransitionDelivery(findDelivery.status, "DELIVERED");

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_STATUS_TRANSITION");
    }

    // Only ownership and existence are left to check before the keys
    // become rows — the bytes went straight to the bucket.
    const [resolvedPhoto] = await this.uploadService.resolvePresignedUploads(
      [{ key: photo }],
      "deliveryPhotos",
      businessId,
    );

    let signaturePath: string | null = null;

    if (signature) {
      // Same namespace as the receipt photo: the app's queue uploads one
      // type per submission, so the signature travels as a delivery photo.
      const [resolvedSignature] =
        await this.uploadService.resolvePresignedUploads(
          [{ key: signature }],
          "deliveryPhotos",
          businessId,
        );

      signaturePath = resolvedSignature.path;
    }

    try {
      const provenAt = new Date();

      // Proof, DELIVERED stamp and the route stop this resolves all commit
      // together. Split apart, a crash in between leaves a DELIVERED delivery
      // on a PENDING stop: the route never closes, because closing is
      // triggered by a stop resolving and no stop would resolve again — and
      // the delivery stays locked out of every future route by the partial
      // unique index that reserves it.
      await database.$transaction(async (tx) => {
        await this.delivery.registerDeliveryProof(
          {
            type: "PROOF",
            deliveryId,
            reportedById: userId,
            latitude,
            longitude,
            photo: resolvedPhoto.path,
            signature: signaturePath,
            received_by,
            client_submission_id,
          },
          // The status canTransitionDelivery was asked about. The upload of
          // the photo sits between that check and this write, which on a phone
          // in a basement can be minutes — the widest window in the module.
          findDelivery.status,
          tx,
        );

        const outcome = stopOutcomeForDelivery("DELIVERED", provenAt);

        if (outcome) {
          await this.route.settleStopForDelivery(
            deliveryId,
            businessId,
            outcome,
            tx,
          );
        }
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: deliveryId,
        description:
          `Entrega para ${findDelivery.recipient_name}: ` +
          `${DELIVERY_STATUS_LABELS[findDelivery.status]} → ` +
          `${DELIVERY_STATUS_LABELS.DELIVERED} (comprovada pelo motorista)`,
        status: DELIVERY_STATUS_LABELS.DELIVERED,
        performedBy: userId,
        businessId,
      });
    } catch (error) {
      // 409 and not 5xx matters twice here. The driver's app classifies a
      // non-transient 4xx as permanent, so the submission stops retrying and
      // lands on the pending screen carrying this message — which is the
      // truth: the delivery was cancelled and no amount of retrying will
      // change that. A 500 would have it retry forever against a wall.
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar comprovar a entrega! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RegisterDeliveryProofUseCase };
