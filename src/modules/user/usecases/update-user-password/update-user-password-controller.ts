import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateUserPasswordUseCase } from "./update-user-password-usecase";

import { updateUserPasswordSchema } from "@/schemas/update-user-password-schema";
import { parseSessionClient } from "../../services/session-service";

class UpdateUserPasswordController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id, sessionId } = request.user;

    const { currentPassword, newPassword } = updateUserPasswordSchema.parse(
      request.body,
    );

    const updateUserPasswordUseCase = container.resolve(
      UpdateUserPasswordUseCase,
    );

    const { token, refresh_token, mustChangePassword } =
      await updateUserPasswordUseCase.execute({
        userId: id,
        currentPassword,
        newPassword,
        // This session is kept and re-issued; the header only picks the web's
        // day or the app's week for a session not bound to a phone.
        sessionId,
        client: parseSessionClient(request.headers["x-trajetto-client"]),
      });

    // The answer carries credentials: never cached on the way.
    reply.header("cache-control", "no-store");

    return reply.status(200).send({
      message: "Senha atualizada com sucesso",
      // Additive (wave 2): the session's new pair. A client that ignores it
      // is signed out by the version bump, as before.
      ...(token && refresh_token && { token, refresh_token }),
      mustChangePassword,
    });
  }
}

export { UpdateUserPasswordController };
