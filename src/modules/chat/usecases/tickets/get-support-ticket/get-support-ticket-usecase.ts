import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/IOccurrence-authorization-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type { SupportTicketOutcome } from "../../../dtos/support-ticket-dto";

import { UploadService } from "@/shared/services/upload-service";
import { labelledAnswers } from "@/modules/delivery/usecases/authorize-occurrence/authorization-notice";

import {
  driverTicketView,
  presentTicket,
  type DriverTicketView,
  type TicketSummary,
} from "../../shared/ticket-presenter";
import { canReopen } from "../../shared/ticket-rules";
import { SupportTicketNotFoundError } from "../../errors/support-ticket-errors";
import {
  canSpeak,
  isTicketOperator,
  loadScopedTicket,
  resolveTicketScope,
} from "../ticket-access";

interface OccurrenceDetail {
  id: string;
  typeName: string;
  description: string | null;
  photos: string[];
  receipt_photo_url: string | null;
  answers: Array<{ label: string; value: string }>;
  reportedBy: { id: string; name: string };
  occurred_at: Date | null;
  created_at: Date;
  authorization_status: string;
  authorizedBy: { id: string; name: string } | null;
  authorized_at: Date | null;
  authorization_note: string | null;
  escalated_at: Date | null;
  blocks_delivery: boolean;
}

interface TicketPermissions {
  canWrite: boolean;
  canAssign: boolean;
  canClose: boolean;
  canReopen: boolean;
  canDecide: boolean;
  closeOutcomes: Array<Exclude<SupportTicketOutcome, "MIGRATED">>;
}

type TicketDetail =
  | (TicketSummary & {
      occurrenceDetail: OccurrenceDetail | null;
      permissions: TicketPermissions;
    })
  | (DriverTicketView & { permissions: TicketPermissions });

/**
 * One ticket with what the tower needs to act without opening anything else
 * (design §4.4): the occurrence as reported (photos signed at read time, the
 * form's answers labelled) and what the requester may do with it.
 */
@injectable()
class GetSupportTicketUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute({
    userId,
    businessId,
    ticketId,
  }: {
    userId: string;
    businessId?: string;
    ticketId: string;
  }): Promise<TicketDetail> {
    const scope = await resolveTicketScope(this.user, userId, businessId);
    const ticket = await loadScopedTicket(this.tickets, scope, ticketId);

    const row = await this.tickets.findRowById(ticket.id, scope.businessId);

    if (!row) throw new SupportTicketNotFoundError();

    const [unread, lastMessages] = await Promise.all([
      this.tickets.unreadCounts(
        [row.id],
        scope.user.id,
        Boolean(scope.driverId),
      ),
      this.tickets.lastMessages([row.id]),
    ]);

    const summary = presentTicket(row, {
      unreadCount: unread.get(row.id) ?? 0,
      lastMessage: lastMessages.get(row.id) ?? null,
    });

    const operator = isTicketOperator(scope);
    const open = row.status === "OPEN";

    const permissions: TicketPermissions = {
      canWrite: open && canSpeak(scope),
      canAssign: open && operator,
      canClose: open && operator,
      canReopen: operator && canReopen(row),
      // The decision's single rule (canDecideAuthorizations) is the operator's.
      canDecide:
        open && operator && row.occurrence?.authorization_status === "PENDING",
      closeOutcomes: operator ? summary.closeOutcomes : [],
    };

    if (scope.driverId) {
      return { ...driverTicketView(summary), permissions };
    }

    return {
      ...summary,
      occurrenceDetail: row.occurrenceId
        ? await this.occurrenceDetail(row.occurrenceId, scope.businessId)
        : null,
      permissions,
    };
  }

  private async occurrenceDetail(
    occurrenceId: string,
    businessId: string,
  ): Promise<OccurrenceDetail | null> {
    const found = await this.authorizations.findForDecision(
      occurrenceId,
      businessId,
    );

    if (!found) return null;

    return {
      id: found.id,
      typeName: found.occurrenceType.name,
      description: found.description,
      photos: await Promise.all(
        found.photos.map((key) => this.uploadService.getFileUrl(key)),
      ),
      receipt_photo_url: found.receipt_photo
        ? await this.uploadService.getFileUrl(found.receipt_photo)
        : null,
      answers: labelledAnswers(
        found.occurrenceType.form_fields,
        found.form_answers,
      ),
      reportedBy: { id: found.reportedBy.id, name: found.reportedBy.name },
      occurred_at: found.occurred_at,
      created_at: found.created_at,
      authorization_status: found.authorization_status,
      authorizedBy: found.authorizedBy,
      authorized_at: found.authorized_at,
      authorization_note: found.authorization_note,
      escalated_at: found.escalated_at,
      blocks_delivery: found.occurrenceType.blocks_delivery,
    };
  }
}

export { GetSupportTicketUseCase };
export type { TicketDetail, TicketPermissions, OccurrenceDetail };
