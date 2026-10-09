import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IOccurrenceAuthorizationRepository } from "../../repositories/IOccurrence-authorization-repository";

import { UploadService } from "@/shared/services/upload-service";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { AppError } from "@/shared/errors/AppError";

import { readFormFields } from "@/modules/occurrence-type/form/occurrence-form-rules";

import { labelledAnswers } from "./authorization-notice";

/** A queue, not a report: more than this waiting is its own emergency. */
const PENDING_QUEUE_LIMIT = 100;

/** How long a request waits before the administrators are told. */
const ESCALATION_AFTER_MS = 10 * 60 * 1000;

interface ListPendingAuthorizationsRequest {
  userId: string;
  /** The MASTER names the company; everyone else is pinned to their own. */
  businessId?: string;
}

/**
 * The tower's queue of reports waiting for an answer (decision 6.3), oldest
 * first, with what the operator needs to decide without opening anything:
 * the delivery, the driver, the answers already labelled, the photos signed.
 */
@injectable()
class ListPendingAuthorizationsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({ userId, businessId }: ListPendingAuthorizationsRequest) {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    assertDispatcher(findUser);

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const { rows, total } = await this.authorizations.listPending(
      resolvedBusinessId,
      PENDING_QUEUE_LIMIT,
    );

    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        deliveryId: row.deliveryId,
        occurrenceTypeId: row.occurrenceTypeId,
        occurrenceType: {
          id: row.occurrenceType.id,
          name: row.occurrenceType.name,
          blocks_delivery: row.occurrenceType.blocks_delivery,
        },
        description: row.description,
        latitude: row.latitude,
        longitude: row.longitude,
        photos: await Promise.all(
          row.photos.map((key) => this.uploadService.getFileUrl(key)),
        ),
        // Decision 14.3: approving a delivery request proves the delivery,
        // so the tower must see the receipt and signature it is approving.
        category: row.category,
        receipt_photo_url: row.receipt_photo
          ? await this.uploadService.getFileUrl(row.receipt_photo)
          : null,
        signature_url: row.signature
          ? await this.uploadService.getFileUrl(row.signature)
          : null,
        received_by: row.received_by,
        form_answers: row.form_answers,
        form_version: row.form_version,
        form_fields: readFormFields(row.occurrenceType.form_fields),
        answers: labelledAnswers(row.occurrenceType.form_fields, row.form_answers),
        reportedBy: { id: row.reportedBy.id, name: row.reportedBy.name },
        occurred_at: row.occurred_at,
        created_at: row.created_at,
        escalated_at: row.escalated_at,
        escalates_at: new Date(row.created_at.getTime() + ESCALATION_AFTER_MS),
        delivery: row.delivery,
      })),
    );

    return {
      data,
      total,
      businessId: resolvedBusinessId,
    };
  }
}

export { ESCALATION_AFTER_MS, ListPendingAuthorizationsUseCase, PENDING_QUEUE_LIMIT };
