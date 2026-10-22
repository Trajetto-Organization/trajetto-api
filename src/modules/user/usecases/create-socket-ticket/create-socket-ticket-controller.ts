import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateSocketTicketUseCase } from "./create-socket-ticket-usecase";

class CreateSocketTicketController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const createSocketTicket = container.resolve(CreateSocketTicketUseCase);

    const { ticket, expiresInSeconds } = await createSocketTicket.execute({
      userId: request.user.id,
      businessId: request.user.businessId,
      sessionId: request.user.sessionId,
      sessionVersion: request.user.sessionVersion,
    });

    // A credential, even a one-use one: never cached by anything in between.
    reply.header("Cache-Control", "no-store");

    return reply.status(201).send({ ticket, expiresIn: expiresInSeconds });
  }
}

export { CreateSocketTicketController };
