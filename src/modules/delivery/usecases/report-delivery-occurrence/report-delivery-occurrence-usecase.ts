import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";

import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { UploadService } from "@/shared/services/upload-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryStatusConflictError,
} from "../errors/delivery-errors";

import {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNotBelongBusinessError,
} from "@/modules/occurrence-type/usecases/errors/occurrence-type-errors";

import {
  statusAfterOccurrence,
  DELIVERY_STATUS_LABELS,
} from "@/shared/delivery/delivery-rules";

import { AppError } from "@/shared/errors/AppError";

interface ReportOccurrenceRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  occurrenceTypeId: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  photos?: string[];
  client_submission_id?: string;
}

@injectable()
class ReportDeliveryOccurrenceUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    occurrenceTypeId,
    description,
    latitude,
    longitude,
    photos = [],
    client_submission_id,
  }: ReportOccurrenceRequest): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Outbox resend: the same submission never becomes a second
    // occurrence, and the status flip it caused the first time is not
    // replayed.
    if (client_submission_id) {
      const alreadyRecorded =
        await this.delivery.findOccurrenceBySubmissionId(client_submission_id);

      if (alreadyRecorded) {
        return;
      }
    }

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    if (!findDelivery) {
      throw new DeliveryNotFoundError();
    }

    if (findDelivery.businessId !== businessId) {
      throw new DeliveryNotBelongBusinessError();
    }

    // Drivers only report on their own deliveries.
    if (findUser.driverId && findDelivery.driverId !== findUser.driverId) {
      throw new DeliveryNotFoundError();
    }

    const findType =
      await this.occurrenceType.findOccurrenceTypeById(occurrenceTypeId);

    if (!findType) {
      throw new OccurrenceTypeNotFoundError();
    }

    if (findType.businessId !== businessId) {
      throw new OccurrenceTypeNotBelongBusinessError();
    }

    if (findType.is_active === false) {
      throw new AppError(
        "Este tipo de ocorrência está desativado e não pode ser usado em novos registros.",
        400,
      );
    }

    // The photo requirement binds the person in the field: a driver cannot
    // register a photo-required type without one. A manager on the web is
    // recording an administrative fact and is not asked for a photo.
    if (
      findType.requires_photo === true &&
      findUser.driverId &&
      photos.length === 0
    ) {
      throw new AppError(
        "Este tipo de ocorrência exige foto anexada ao registro.",
        400,
        "OCCURRENCE_PHOTO_REQUIRED",
      );
    }

    // Only ownership and existence are left to check before the keys
    // become rows — the bytes went straight to the bucket.
    let photoPaths: string[] = [];

    if (photos.length > 0) {
      const resolved = await this.uploadService.resolvePresignedUploads(
        photos.map((key) => ({ key })),
        "deliveryPhotos",
        businessId,
      );

      photoPaths = resolved.map((entry) => entry.path);
    }

    try {
      // A blocking type flips the active delivery to FAILED (Comprovei
      // semantics); the trail records both the occurrence and the flip.
      const nextStatus = statusAfterOccurrence(
        findDelivery.status,
        findType.blocks_delivery === true,
      );

      // Occurrence, status flip and the manager's alert commit together:
      // a crash in between can neither ring about a rolled-back occurrence
      // nor record an Insucesso nobody was told about.
      await database.$transaction(async (tx) => {
        await this.delivery.createOccurrence(
          {
            deliveryId,
            occurrenceTypeId,
            reportedById: userId,
            description,
            latitude,
            longitude,
            photos: photoPaths,
            client_submission_id: client_submission_id ?? null,
          },
          tx,
        );

        if (nextStatus !== findDelivery.status) {
          await this.delivery.updateDeliveryStatus(
            deliveryId,
            // statusAfterOccurrence was asked about findDelivery.status, so
            // that is what the write has to still find. If the delivery was
            // proven or cancelled while the driver was uploading the photos,
            // the whole transaction rolls back — occurrence, flip and alert —
            // rather than dragging a finished delivery back to FAILED.
            { status: nextStatus, expectedStatus: findDelivery.status },
            tx,
          );
        }

        // Only a blocking occurrence rings the manager's bell — it changed
        // the delivery's fate. Informational ones stay in the trail.
        if (findType.blocks_delivery === true) {
          await this.outbox.publish(tx, {
            topic: "delivery-occurrence.reported",
            aggregateType: "delivery",
            aggregateId: deliveryId,
            businessId,
            actorId: userId,
            payload: {
              deliveryId,
              businessId,
              recipientName: findDelivery.recipient_name,
              occurrenceTypeName: findType.name,
              blocksDelivery: true,
              description: description ?? null,
              photosCount: photoPaths.length,
              reporterName: findUser.name,
              deliveryStatusAfter: DELIVERY_STATUS_LABELS[nextStatus],
            },
          });
        }
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: deliveryId,
        description:
          `Ocorrência "${findType.name}" registrada na entrega para ` +
          `${findDelivery.recipient_name}`,
        status: DELIVERY_STATUS_LABELS[nextStatus],
        performedBy: userId,
        businessId,
      });
    } catch (error) {
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar registrar a ocorrência! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ReportDeliveryOccurrenceUseCase };
