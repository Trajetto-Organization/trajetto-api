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

import { announceStopSettled } from "@/shared/route/route-realtime";

import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";

import { OutboxService } from "@/shared/notifications/outbox-service";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import {
  announceRouteClosed,
  deliveryEventPayload,
} from "@/shared/integration/announce";

import { IProofAuditRepository } from "../../repositories/IProof-audit-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";

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
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("ProofAuditRepository")
    private audits: IProofAuditRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
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
      await this.delivery.findEventBySubmissionId(client_submission_id, businessId);

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
      // Captured to be announced AFTER the commit: a socket event about a
      // write that rolled back is a lie the client cannot undo.
      let settled: Awaited<
        ReturnType<IRouteRepository["settleStopForDelivery"]>
      > = null;

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
          settled = await this.route.settleStopForDelivery(
            deliveryId,
            businessId,
            outcome,
            tx,
          );
        }

        // The person who was waiting for this. Published in the SAME
        // transaction as the proof, because a delivery that is DELIVERED in
        // the database and whose customer was never told is the state the
        // whole feature exists to prevent — and the check happens before the
        // publish so a carrier that collects no contact details never writes
        // an outbox row that could only ever expand into nothing.
        if (hasSomebodyToTell(findDelivery)) {
          await this.outbox.publish(tx, {
            topic: "delivery.delivered",
            aggregateType: "delivery",
            aggregateId: deliveryId,
            businessId,
            actorId: userId,
            payload: {
              ...buildDeliveryCustomerPayload(deliveryId, findDelivery),
              deliveredAt: provenAt,
              receivedBy: received_by ?? null,
            },
          });
        }

        // The customers' systems. Two topics and not one: an ERP that only
        // tracks whether a document was delivered subscribes to
        // `delivery.delivered`, and one that audits receipts subscribes to
        // `proof.registered` — and neither should have to filter the other's
        // events out.
        //
        // In the SAME transaction, for the reason the outbox row above is: an
        // event queued after the commit is an event a crash in between erases,
        // and the customer's ERP then holds a delivery that our database says
        // is done. Nobody notices until somebody reconciles.
        await this.webhooks.announce(
          "proof.registered",
          businessId,
          deliveryEventPayload({ ...findDelivery, id: deliveryId }),
          tx,
        );

        await this.webhooks.announce(
          "delivery.delivered",
          businessId,
          deliveryEventPayload({
            ...findDelivery,
            id: deliveryId,
            status: "DELIVERED",
          }),
          tx,
        );

        await announceRouteClosed(this.webhooks, businessId, settled, tx);
      });

      // The card a person will look at. Queued the moment the delivery is
      // proven, not when the model answers: a receipt whose analysis never ran
      // — no quota, no key, a provider outage — still has to reach a human,
      // and a queue that only fills on a successful AI call would silently
      // stop auditing the day the AI stopped working.
      //
      // After the commit, and deliberately not inside it: the card is a
      // convenience for the office, and a failure to write it must never cost
      // the driver a proof they are standing in the street to record.
      await this.audits
        .enqueue(deliveryId, businessId)
        .catch((error) =>
          console.error("[ProofAudit] Failed to enqueue the receipt:", error),
        );

      await this.requestProofAnalysis(
        deliveryId,
        businessId,
        userId,
        resolvedPhoto.path,
        signaturePath,
        findDelivery,
        provenAt,
      );

      // The panel and the control tower are watching this stop.
      announceStopSettled(businessId, settled);

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
  /**
   * Asks the model to read the receipt, if this company bought that.
   *
   * Fire-and-forget on purpose, exactly like the checklist and the odometer:
   * the driver is standing in the street and the answer is a suggestion on a
   * card somebody opens later. A failure here costs the office a hint, and it
   * must never cost the driver the proof.
   *
   * The expected values travel WITH the request rather than being looked up at
   * analysis time, because the analysis runs minutes later and the delivery may
   * have been corrected in between — the model has to be asked about the
   * document that was proven, not about the row as it stands now.
   */
  private async requestProofAnalysis(
    deliveryId: string,
    businessId: string,
    userId: string,
    photoPath: string,
    signaturePath: string | null,
    delivery: { invoice_number?: string | null; code?: string | null; recipient_name: string },
    provenAt: Date,
  ): Promise<void> {
    try {
      const findBusiness = await this.business.findBusinessById(businessId);

      // Zero is how a company says it did not buy this. The card is already in
      // the queue; it simply arrives with no suggestion, which is exactly what
      // a reviewer without AI should see.
      if ((findBusiness?.ai_analysis_limit ?? 0) <= 0) return;

      await AIAnalysisService.getInstance().requestAnalysis({
        type: "DELIVERY_PROOF",
        recordId: deliveryId,
        businessId,
        requestedById: userId,
        input: {
          photoPath,
          signaturePath,
          expectedDocument: delivery.invoice_number ?? delivery.code ?? null,
          expectedRecipient: delivery.recipient_name,
          provenOn: provenAt.toISOString().slice(0, 10),
        },
      });
    } catch (error) {
      console.error("[AI] Failed to request proof verification:", error);
    }
  }
}

export { RegisterDeliveryProofUseCase };
