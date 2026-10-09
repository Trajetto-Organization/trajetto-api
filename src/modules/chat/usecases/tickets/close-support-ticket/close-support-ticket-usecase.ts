import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type { SupportTicket, SupportTicketRow } from "../../../dtos/support-ticket-dto";

import { NotificationService } from "@/shared/services/notification-service";
import {
  DELIVERY_STATUS_LABELS,
  type DeliveryStatus,
} from "@/shared/delivery/delivery-rules";

import {
  DecideOccurrenceAuthorizationUseCase,
  type DecideOccurrenceAuthorizationResult,
} from "@/modules/delivery/usecases/authorize-occurrence/decide-occurrence-authorization-usecase";

import {
  SupportTicketAlreadyClosedError,
  SupportTicketAuthorizationPendingError,
  SupportTicketNotAuthorizationError,
  SupportTicketNotFoundError,
} from "../../errors/support-ticket-errors";
import { closeOutcomeProblem } from "../../shared/ticket-rules";
import { presentTicket, type TicketSummary } from "../../shared/ticket-presenter";
import { announceTicket } from "../../shared/ticket-operations";
import { assertOperator, loadScopedTicket, resolveTicketScope } from "../ticket-access";

type CloseOutcome = "RESOLVED" | "APPROVED" | "DENIED";

interface CloseSupportTicketRequest {
  userId: string;
  businessId?: string;
  ticketId: string;
  outcome: CloseOutcome;
  note?: string | null;
}

interface CloseSupportTicketResponse {
  data: TicketSummary;
  decision?: DecideOccurrenceAuthorizationResult;
  replayed: boolean;
}

/** Thrown inside the transaction when someone closed it first. */
class CloseLostError extends Error {}

/**
 * Closes a ticket (design §4.6). On an occurrence waiting for the tower,
 * closing IS the decision: it delegates to the existing decision use case,
 * which closes the ticket in its own transaction — one path, never a
 * parallel one. Otherwise the ticket closes as resolved, with "quem tratou"
 * filled in by whoever closes it.
 */
@injectable()
class CloseSupportTicketUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
    @inject(DecideOccurrenceAuthorizationUseCase)
    private decide: DecideOccurrenceAuthorizationUseCase,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(request: CloseSupportTicketRequest): Promise<CloseSupportTicketResponse> {
    const scope = await resolveTicketScope(this.user, request.userId, request.businessId);

    assertOperator(scope);

    const ticket = await loadScopedTicket(this.tickets, scope, request.ticketId);
    const row = await this.row(ticket.id, scope.businessId);

    if (row.status === "CLOSED") return this.answerClosed(row, request);

    const note = request.note?.trim() ? request.note.trim() : null;
    const authorization = row.occurrence?.authorization_status ?? null;

    const problem = closeOutcomeProblem(authorization, request.outcome);

    if (problem === "SUPPORT_TICKET_AUTHORIZATION_PENDING") {
      throw new SupportTicketAuthorizationPendingError();
    }

    if (problem === "SUPPORT_TICKET_NOT_AUTHORIZATION") {
      throw new SupportTicketNotAuthorizationError();
    }

    if (request.outcome !== "RESOLVED") {
      // The decision's own rules apply untouched: note on a denial, one
      // decision per request (409 with who decided), the effect and the
      // driver's notice. It closes this ticket in its transaction.
      const decision = await this.decide.execute({
        userId: request.userId,
        businessId: scope.businessId,
        occurrenceId: row.occurrenceId!,
        decision: request.outcome,
        note,
      });

      return {
        data: presentTicket(await this.row(ticket.id, scope.businessId)),
        decision,
        replayed: decision.replayed,
      };
    }

    const at = new Date();
    const actor = { actor_kind: "USER" as const, actorId: scope.user.id, actor_name: scope.user.name };

    try {
      await database.$transaction(async (tx) => {
        const locked = await this.tickets.lockForUpdate(ticket.id, scope.businessId, tx);

        if (!locked || locked.status !== "OPEN") throw new CloseLostError();

        if (locked.assigneeId === null) {
          await this.tickets.assign(
            { id: locked.id, businessId: scope.businessId, assigneeId: scope.user.id, at },
            tx,
          );

          await this.tickets.addEvent(
            {
              ticketId: locked.id,
              businessId: scope.businessId,
              type: "ASSIGNED",
              ...actor,
              target_user_id: scope.user.id,
              target_user_name: scope.user.name,
            },
            tx,
          );
        }

        const closed = await this.tickets.close(
          {
            id: locked.id,
            businessId: scope.businessId,
            closedById: scope.user.id,
            outcome: "RESOLVED",
            note,
            at,
          },
          tx,
        );

        if (!closed) throw new CloseLostError();

        await this.tickets.addEvent(
          {
            ticketId: locked.id,
            businessId: scope.businessId,
            type: "CLOSED",
            ...actor,
            outcome: "RESOLVED",
            note,
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof CloseLostError) {
        return this.answerClosed(await this.row(ticket.id, scope.businessId), request);
      }

      throw error;
    }

    await announceTicket(this.tickets, {
      ticketId: ticket.id,
      businessId: scope.businessId,
      type: "ticket.closed",
      actor: { id: scope.user.id, name: scope.user.name },
    });

    const after = await this.row(ticket.id, scope.businessId);

    if (after.delivery) {
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: after.delivery.id,
        description:
          `Atendimento #${after.number} encerrado na entrega para ${after.delivery.recipient_name}` +
          (note ? `: ${note}` : ""),
        status:
          DELIVERY_STATUS_LABELS[after.delivery.status as DeliveryStatus] ?? after.delivery.status,
        performedBy: scope.user.id,
        businessId: scope.businessId,
      });
    }

    return { data: presentTicket(after), replayed: false };
  }

  private async row(id: string, businessId: string): Promise<SupportTicketRow> {
    const row = await this.tickets.findRowById(id, businessId);

    if (!row) throw new SupportTicketNotFoundError();

    return row;
  }

  /**
   * Already closed: the same person with the same outcome is a replay (a
   * double click); anything else is 409 with who closed it, when and how.
   */
  private answerClosed(
    row: SupportTicketRow,
    request: CloseSupportTicketRequest,
  ): CloseSupportTicketResponse {
    if (row.closedById === request.userId && row.close_outcome === request.outcome) {
      return { data: presentTicket(row), replayed: true };
    }

    throw new SupportTicketAlreadyClosedError({
      closedBy: row.closedBy,
      closed_at: row.closed_at,
      outcome: row.close_outcome,
    });
  }
}

export { CloseSupportTicketUseCase };
export type { CloseSupportTicketRequest, CloseSupportTicketResponse, SupportTicket };
