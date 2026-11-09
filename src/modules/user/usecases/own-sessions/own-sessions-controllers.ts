import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ownSessionParamsSchema } from "@/schemas/own-session-schema";

import {
  ListOwnSessionsUseCase,
  RevokeOwnSessionUseCase,
} from "./own-sessions-usecases";

class ListOwnSessionsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id, sessionId } = request.user;

    const sessions = await container
      .resolve(ListOwnSessionsUseCase)
      .execute({ userId: id, sessionId });

    return reply.status(200).send({
      data: sessions.map((session) => ({
        ...session,
        created_at: session.created_at.toISOString(),
        last_activity_at: session.last_activity_at.toISOString(),
      })),
    });
  }
}

class RevokeOwnSessionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id: targetId } = ownSessionParamsSchema.parse(request.params);

    await container.resolve(RevokeOwnSessionUseCase).execute({
      userId: request.user.id,
      sessionId: request.user.sessionId,
      targetId,
    });

    return reply.status(204).send();
  }
}

export { ListOwnSessionsController, RevokeOwnSessionController };
