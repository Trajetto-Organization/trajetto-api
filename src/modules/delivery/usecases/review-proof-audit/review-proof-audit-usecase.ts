import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IProofAuditRepository } from "../../repositories/IProof-audit-repository";

import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { AppError } from "@/shared/errors/AppError";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import type { ProofAuditRecord } from "../../dtos/proof-audit-dto";

interface ReviewProofAuditRequest {
  userId: string;
  businessId: string;

  auditId: string;

  status: "APPROVED" | "REJECTED";
  rejection_reason?: string;
}

/**
 * The name for the occurrence a rejection leaves behind.
 *
 * One per company, created the first time somebody rejects a receipt. Using
 * the occurrence machinery rather than inventing a parallel record means the
 * rejection lands where the operation already looks: the delivery's timeline,
 * the occurrence listing, the occurrence export the carrier sends its shipper.
 */
const REJECTION_TYPE_NAME = "Comprovante rejeitado";

/**
 * A person's verdict on a receipt.
 *
 * This is the half of the feature the machine cannot do. The audit that
 * produced this slice recorded why: an AI verdict with nobody behind it does
 * not close a probative cycle, and a delivery whose proof was never looked at
 * by a human is a delivery whose proof will not hold when it is disputed.
 *
 * A rejection demands a reason, and the reason is not paperwork: it is what
 * the dispatcher reads to decide whether the delivery goes back out, and what
 * the shipper is shown when they ask why a receipt was refused.
 */
@injectable()
class ReviewProofAuditUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProofAuditRepository")
    private audits: IProofAuditRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceTypes: IOccurrenceTypeRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    auditId,
    status,
    rejection_reason,
  }: ReviewProofAuditRequest): Promise<ProofAuditRecord> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    assertDispatcher(findUser);
    assertTenantAccess(findUser, businessId);

    const reason = rejection_reason?.trim() || null;

    // A receipt refused with no reason is a receipt nobody can act on: the
    // dispatcher cannot decide whether to send it back out, and the shipper
    // asking why gets silence.
    if (status === "REJECTED" && !reason) {
      throw new AppError(
        "Diga por que o comprovante foi rejeitado.",
        400,
        "REJECTION_REASON_REQUIRED",
      );
    }

    const found = await this.audits.findById(auditId, businessId);

    // Same 404 for "does not exist" and "is not yours".
    if (!found) {
      throw new AppError(
        "Comprovante não encontrado na fila.",
        404,
        "PROOF_AUDIT_NOT_FOUND",
      );
    }

    // The verdict and the event it announces in ONE transaction. A shipper
    // that audits its own carrier acts on `proof.rejected`; an event queued
    // after the commit is an event a crash in between erases, and the card
    // then reads REJECTED here while their system still shows it accepted.
    const reviewed = await database.$transaction(async (tx) => {
      const settled = await this.audits.review(
        {
          auditId,
          businessId,
          reviewedById: userId,
          status,
          rejection_reason: status === "REJECTED" ? reason : null,
        },
        tx,
      );

      // 409 and not 500: the request was well formed and the caller was
      // allowed to make it — somebody else simply got there first. Two
      // reviewers open the same card, and the second has to be told rather
      // than overwriting the first name on the record of who decided it.
      if (!settled) {
        throw new AppError(
          "Este comprovante já foi revisado por outra pessoa.",
          409,
          "PROOF_AUDIT_ALREADY_REVIEWED",
        );
      }

      // The customers' systems. A shipper auditing its own carrier is the
      // reason this topic exists: a receipt refused here is a receipt they
      // will be asked about, and hearing it from us beats hearing it from the
      // customer.
      await this.webhooks.announce(
        status === "APPROVED" ? "proof.approved" : "proof.rejected",
        businessId,
        {
          delivery_id: found.deliveryId,
          audit_id: found.id,
          rejection_reason: status === "REJECTED" ? reason : null,
        },
        tx,
      );

      return settled;
    });

    // After the verdict commits, and outside it on purpose: the occurrence is
    // a trail entry for the office, and an `ensureByName` upsert on a table
    // every tenant shares does not belong in the window that holds the card.
    if (status === "REJECTED") {
      await this.recordRejection(found.deliveryId, businessId, userId, reason!);
    }

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "update",
      entityId: found.deliveryId,
      description:
        status === "APPROVED"
          ? "Comprovante aprovado na auditoria"
          : `Comprovante rejeitado na auditoria: ${reason}`,
      status: status === "APPROVED" ? "Aprovado" : "Rejeitado",
      performedBy: userId,
      businessId,
    });

    return reviewed;
  }

  /**
   * Leaves the rejection where the operation already looks.
   *
   * The occurrence type is created on first use rather than seeded for every
   * company: a carrier that never rejects a receipt should not carry a word it
   * never spends, and the catalogue screen is a list of what this company
   * actually says.
   *
   * `blocks_delivery: false` deliberately. A rejected receipt does NOT flip the
   * delivery to Insucesso on its own — whether the load goes back out is the
   * dispatcher's call, and they may have a verbal confirmation the photo does
   * not show. Flipping it here would take that decision away and, worse, would
   * do it automatically on the word of a queue.
   */
  private async recordRejection(
    deliveryId: string,
    businessId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    const type = await this.occurrenceTypes.ensureByName(businessId, {
      name: REJECTION_TYPE_NAME,
      description:
        "Gerado pela auditoria de comprovantes quando alguém rejeita o canhoto enviado pelo motorista.",
      blocks_delivery: false,
      requires_photo: false,
    });

    await this.delivery.createOccurrence({
      deliveryId,
      occurrenceTypeId: type.id,
      reportedById: userId,
      description: reason,
      photos: [],
    });
  }
}

export { REJECTION_TYPE_NAME, ReviewProofAuditUseCase };
