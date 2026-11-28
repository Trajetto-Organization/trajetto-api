import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { revokeSessionSchema } from "@/schemas/driver-access-schema";

import { RevokeSessionUseCase } from "./revoke-session-usecase";

class RevokeSessionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = revokeSessionSchema.parse(request.body);

    await container.resolve(RevokeSessionUseCase).execute(token);

    return reply.status(204).send();
  }
}

export { RevokeSessionController };
