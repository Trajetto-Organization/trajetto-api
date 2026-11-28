import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type {
  IOccurrenceAuthorizationRepository,
  PendingAuthorizationRow,
} from "../../repositories/IOccurrence-authorization-repository";

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

type PendingAuthorizationsView = "full" | "summary";

type PendingAuthorizationFullRow = Awaited<ReturnType<typeof fullOf>>;
type PendingAuthorizationSummaryRow = ReturnType<typeof summaryOf>;

interface PendingAuthorizationsPage<V extends PendingAuthorizationsView, R> {
  view: V;
  data: R[];
  total: number;
  businessId: string;
}

type FullPendingAuthorizations = PendingAuthorizationsPage<
  "full",
  PendingAuthorizationFullRow
>;
type SummaryPendingAuthorizations = PendingAuthorizationsPage<
  "summary",
  PendingAuthorizationSummaryRow
>;

interface ListPendingAuthorizationsRequest {
  userId: string;
  /** The MASTER names the company; everyone else is pinned to their own. */
  businessId?: string;

  /**
   * "full" (the default, the web's queue) or "summary" (wave 4, the app's
   * list): the summary signs nothing and leaves the form out, so a phone
   * polling every 30 s costs a row read, not a hundred signed URLs.
   */
  view?: PendingAuthorizationsView;

  /** Only this request, while it still waits (the detail a push opens). */
  occurrenceId?: string;
}

/** A queue row as the web's tower shows it: everything, photos signed. */
async function fullOf(
  row: PendingAuthorizationRow,
  uploadService: UploadService,
) {
  return {
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
      row.photos.map((key) => uploadService.getFileUrl(key)),
    ),
    // Decision 14.3: approving a delivery request proves the delivery,
    // so the tower must see the receipt and signature it is approving.
    category: row.category,
    receipt_photo_url: row.receipt_photo
      ? await uploadService.getFileUrl(row.receipt_photo)
      : null,
    signature_url: row.signature
      ? await uploadService.getFileUrl(row.signature)
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
  };
}

/**
 * A queue row as the app's list shows it (wave 4): who, where, what and how
 * long, and how many photos wait in the detail — never a signed URL, the
 * form or the answers. Allowlisted field by field, so a column added to the
 * full row does not leak into the list a phone polls.
 */
function summaryOf(row: PendingAuthorizationRow) {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    occurrenceTypeId: row.occurrenceTypeId,
    occurrenceType: {
      id: row.occurrenceType.id,
      name: row.occurrenceType.name,
      blocks_delivery: row.occurrenceType.blocks_delivery,
    },
    category: row.category,
    description: row.description,
    photos_count: row.photos.length,
    has_receipt_photo: Boolean(row.receipt_photo),
    has_signature: Boolean(row.signature),
    reportedBy: { id: row.reportedBy.id, name: row.reportedBy.name },
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    escalated_at: row.escalated_at,
    escalates_at: new Date(row.created_at.getTime() + ESCALATION_AFTER_MS),
    delivery: row.delivery,
  };
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

  execute(
    request: ListPendingAuthorizationsRequest & { view: "summary" },
  ): Promise<SummaryPendingAuthorizations>;
  execute(
    request: ListPendingAuthorizationsRequest & { view?: "full" },
  ): Promise<FullPendingAuthorizations>;
  execute(
    request: ListPendingAuthorizationsRequest,
  ): Promise<FullPendingAuthorizations | SummaryPendingAuthorizations>;
  async execute({
    userId,
    businessId,
    view = "full",
    occurrenceId,
  }: ListPendingAuthorizationsRequest): Promise<
    FullPendingAuthorizations | SummaryPendingAuthorizations
  > {
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
      { occurrenceId },
    );

    if (view === "summary") {
      return {
        view,
        data: rows.map((row) => summaryOf(row)),
        total,
        businessId: resolvedBusinessId,
      };
    }

    const data = await Promise.all(
      rows.map((row) => fullOf(row, this.uploadService)),
    );

    return {
      view,
      data,
      total,
      businessId: resolvedBusinessId,
    };
  }
}

export {
  ESCALATION_AFTER_MS,
  ListPendingAuthorizationsUseCase,
  PENDING_QUEUE_LIMIT,
};
export type {
  FullPendingAuthorizations,
  PendingAuthorizationsView,
  SummaryPendingAuthorizations,
};
