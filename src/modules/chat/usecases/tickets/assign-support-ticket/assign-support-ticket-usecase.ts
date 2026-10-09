import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";

import {
  SupportTicketAssigneeChangedError,
  SupportTicketAssigneeNotFoundError,
  SupportTicketClosedError,
  SupportTicketNotFoundError,
} from "../../errors/support-ticket-errors";
import { presentTicket, type TicketSummary } from "../../shared/ticket-presenter";
import { announceTicket } from "../../shared/ticket-operations";
import { assertOperator, loadScopedTicket, resolveTicketScope } from "../ticket-access";

interface AssignSupportTicketRequest {
  userId: string;
  businessId?: string;
  ticketId: string;
  /** Me = take it; another operator = transfer; null = release. */
  assigneeId: string | null;
  /** What the screen showed; undefined = unconditional. */
  expectedAssigneeId?: string | null;
}

/** Thrown inside the transaction when the conditional write lost. */
class AssignLostError extends Error {}

/**
 * Take, transfer or release a ticket (design §4.7). Conditional on what the
 * screen showed, so nobody "steals" a ticket without seeing that someone
 * else already took it.
 */
@injectable()
class AssignSupportTicketUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
  ) {}

  async execute(
    request: AssignSupportTicketRequest,
  ): Promise<{ data: TicketSummary; replayed: boolean }> {
    const scope = await resolveTicketScope(this.user, request.userId, request.businessId);

    assertOperator(scope);

    const ticket = await loadScopedTicket(this.tickets, scope, request.ticketId);

    // A candidate is an operator of THIS company: another tenant's user, a
    // driver or a revoked account reads as "not found".
    let target: { id: string; name: string } | null = null;

    if (request.assigneeId) {
      const operators = await this.user.findDeliveryOperators(scope.businessId);
      const found = operators.find((operator) => operator.id === request.assigneeId);

      if (!found) throw new SupportTicketAssigneeNotFoundError();

      target = { id: found.id, name: found.name };
    }

    if (ticket.status !== "OPEN") {
      throw new SupportTicketClosedError({
        ticketId: ticket.id,
        number: ticket.number,
        closed_at: ticket.closed_at,
      });
    }

    if (ticket.assigneeId === request.assigneeId) {
      return { data: presentTicket((await this.tickets.findRowById(ticket.id, scope.businessId))!), replayed: true };
    }

    const at = new Date();

    try {
      await database.$transaction(async (tx) => {
        const changed = await this.tickets.assign(
          {
            id: ticket.id,
            businessId: scope.businessId,
            assigneeId: request.assigneeId,
            expectedAssigneeId: request.expectedAssigneeId,
            at,
          },
          tx,
        );

        if (!changed) throw new AssignLostError();

        await this.tickets.addEvent(
          {
            ticketId: ticket.id,
            businessId: scope.businessId,
            type: target ? "ASSIGNED" : "UNASSIGNED",
            actor_kind: "USER",
            actorId: scope.user.id,
            actor_name: scope.user.name,
            target_user_id: target?.id ?? null,
            target_user_name: target?.name ?? null,
          },
          tx,
        );
      });
    } catch (error) {
      if (!(error instanceof AssignLostError)) throw error;

      const current = await this.tickets.findRowById(ticket.id, scope.businessId);

      if (!current) throw new SupportTicketNotFoundError();

      if (current.status !== "OPEN") {
        throw new SupportTicketClosedError({
          ticketId: current.id,
          number: current.number,
          closed_at: current.closed_at,
        });
      }

      // Somebody else already put it where this request wanted it.
      if (current.assigneeId === request.assigneeId) {
        return { data: presentTicket(current), replayed: true };
      }

      throw new SupportTicketAssigneeChangedError(current.assignee);
    }

    await announceTicket(this.tickets, {
      ticketId: ticket.id,
      businessId: scope.businessId,
      type: "ticket.assigned",
      actor: { id: scope.user.id, name: scope.user.name },
    });

    const row = await this.tickets.findRowById(ticket.id, scope.businessId);

    return { data: presentTicket(row!), replayed: false };
  }
}

export { AssignSupportTicketUseCase };
export type { AssignSupportTicketRequest };
