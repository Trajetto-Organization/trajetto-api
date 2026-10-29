import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type { SupportTicketEvent } from "../../../dtos/support-ticket-dto";

import { permissionDenied } from "@/shared/errors/access-errors";
import { loadScopedTicket, resolveTicketScope } from "../ticket-access";

/** Dozens per ticket in practice; a ceiling, not a page. */
const TICKET_EVENTS_LIMIT = 500;

/**
 * The ticket's immutable trail (design §4.9), in order: opened, assigned,
 * decided, closed… with the names as they were. The tower's view only — the
 * driver never sees the juggling inside the company.
 */
@injectable()
class ListSupportTicketEventsUseCase {
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
  }): Promise<{ data: SupportTicketEvent[] }> {
    const scope = await resolveTicketScope(
      this.user,
      request.userId,
      request.businessId,
    );

    if (scope.driverId) {
      throw permissionDenied(
        "Motoristas não possuem permissão para acessar este recurso.",
      );
    }

    const ticket = await loadScopedTicket(
      this.tickets,
      scope,
      request.ticketId,
    );

    return {
      data: await this.tickets.listEvents(
        ticket.id,
        scope.businessId,
        TICKET_EVENTS_LIMIT,
      ),
    };
  }
}

export { ListSupportTicketEventsUseCase, TICKET_EVENTS_LIMIT };
