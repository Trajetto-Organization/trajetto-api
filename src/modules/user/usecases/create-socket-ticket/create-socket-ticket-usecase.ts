import { inject, injectable } from "tsyringe";

import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import type {
  ISocketTicketStore,
  IssuedSocketTicket,
} from "@/shared/socket/socket-ticket";

interface CreateSocketTicketInput {
  userId: string;
  businessId: string | null;
  sessionId: string;
  sessionVersion: number;
}

/**
 * Mints a one-use ticket for the caller's own session.
 *
 * Everything in it comes from the authenticated request, never from a body:
 * the handshake that redeems it re-checks that this same session is still
 * alive, on the same version and company, before it opens anything.
 */
@injectable()
class CreateSocketTicketUseCase {
  constructor(
    @inject("SocketTicketStore")
    private readonly store: ISocketTicketStore,
  ) {}

  async execute(input: CreateSocketTicketInput): Promise<IssuedSocketTicket> {
    try {
      return await this.store.issue({
        userId: input.userId,
        businessId: input.businessId,
        sessionId: input.sessionId,
        sessionVersion: input.sessionVersion,
      });
    } catch {
      // Redis away: no ticket can be stored, so none can be redeemed. The
      // web's socket retries with its own back-off.
      throw new ServiceBusyError(
        "Tempo real indisponível no momento. Tente novamente em instantes.",
        "SOCKET_TICKET_UNAVAILABLE",
        5,
      );
    }
  }
}

export { CreateSocketTicketUseCase };
export type { CreateSocketTicketInput };
