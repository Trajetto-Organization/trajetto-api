import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";

import { sendChatReadEvent } from "@/websocket";

import { canWriteInChat } from "../../shared/chat-access-rules";
import { loadScopedTicket, resolveTicketScope } from "../ticket-access";

/**
 * Advances (never rewinds) the requester's cursor on one ticket. Same rules
 * as the thread's: clamped to now, and a MASTER watching for support moves
 * nothing — the driver's double check must never say "the base read it"
 * because the vendor looked.
 */
@injectable()
class MarkSupportTicketReadUseCase {
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
    readAt?: Date;
  }): Promise<{ last_read_at: Date }> {
    const scope = await resolveTicketScope(
      this.user,
      request.userId,
      request.businessId,
    );
    const ticket = await loadScopedTicket(
      this.tickets,
      scope,
      request.ticketId,
    );

    const now = new Date();
    const lastReadAt =
      request.readAt && request.readAt < now ? request.readAt : now;

    if (!canWriteInChat(scope.user.role)) return { last_read_at: lastReadAt };

    await this.tickets.markRead(ticket.id, scope.user.id, lastReadAt);

    const driverUser = await this.user.findUserByDriverId(ticket.driverId);

    sendChatReadEvent(scope.businessId, driverUser?.id ?? null, {
      threadId: ticket.threadId,
      userId: scope.user.id,
      last_read_at: lastReadAt.toISOString(),
      ticketId: ticket.id,
    });

    return { last_read_at: lastReadAt };
  }
}

export { MarkSupportTicketReadUseCase };
