import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";

import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { AppError } from "@/shared/errors/AppError";

import { SupportTicketLegacyReadOnlyError } from "../../errors/support-ticket-errors";
import { presentTicket, type TicketSummary } from "../../shared/ticket-presenter";
import { announceTicket } from "../../shared/ticket-operations";
import { assertOperator, loadScopedTicket, resolveTicketScope } from "../ticket-access";

/**
 * CLOSED → OPEN (design §4.8). A decision is never undone: the occurrence
 * stays APPROVED/DENIED, its effect was applied and told. A closed LEGACY
 * history does not reopen — the tower opens a new subject instead.
 */
@injectable()
class ReopenSupportTicketUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
  ) {}

  async execute(request: {
    userId: string;
    businessId?: string;
    ticketId: string;
    note?: string | null;
  }): Promise<{ data: TicketSummary; replayed: boolean }> {
    const scope = await resolveTicketScope(this.user, request.userId, request.businessId);

    assertOperator(scope);

    const ticket = await loadScopedTicket(this.tickets, scope, request.ticketId);

    if (ticket.status === "OPEN") {
      const row = await this.tickets.findRowById(ticket.id, scope.businessId);

      return { data: presentTicket(row!), replayed: true };
    }

    if (ticket.kind === "LEGACY") throw new SupportTicketLegacyReadOnlyError();

    const note = request.note?.trim() ? request.note.trim() : null;
    let reopened = false;

    try {
      await database.$transaction(async (tx) => {
        reopened = await this.tickets.reopen(ticket.id, scope.businessId, tx);

        if (!reopened) return;

        await this.tickets.addEvent(
          {
            ticketId: ticket.id,
            businessId: scope.businessId,
            type: "REOPENED",
            actor_kind: "USER",
            actorId: scope.user.id,
            actor_name: scope.user.name,
            note,
          },
          tx,
        );
      });
    } catch (error) {
      // The delivery or route already has another open ticket (one open per
      // delivery/route): the conversation continues there.
      if (isUniqueViolation(error)) {
        throw new AppError(
          "Já existe um atendimento aberto para esta entrega ou rota. Continue por ele.",
          409,
          "SUPPORT_TICKET_OPEN_EXISTS",
        );
      }

      throw error;
    }

    if (reopened) {
      await announceTicket(this.tickets, {
        ticketId: ticket.id,
        businessId: scope.businessId,
        type: "ticket.reopened",
        actor: { id: scope.user.id, name: scope.user.name },
      });
    }

    const row = await this.tickets.findRowById(ticket.id, scope.businessId);

    return { data: presentTicket(row!), replayed: !reopened };
  }
}

export { ReopenSupportTicketUseCase };
