import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { createOwnPasswordSchema } from "@/schemas/update-user-password-schema";

import { parseSessionClient } from "../../services/session-service";
import { CreateOwnPasswordUseCase } from "./create-own-password-usecase";

class CreateOwnPasswordController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id, sessionId } = request.user;
    const { password } = createOwnPasswordSchema.parse(request.body);

    const { token, refresh_token, mustChangePassword } = await container
      .resolve(CreateOwnPasswordUseCase)
      .execute({
        userId: id,
        sessionId,
        password,
        client: parseSessionClient(request.headers["x-trajetto-client"]),
      });

    // The answer carries credentials: never cached on the way.
    reply.header("cache-control", "no-store");

    return reply.status(200).send({
      message: "Senha criada com sucesso.",
      token,
      refresh_token,
      mustChangePassword,
    });
  }
}

export { CreateOwnPasswordController };
