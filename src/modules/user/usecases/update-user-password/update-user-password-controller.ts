import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateUserPasswordUseCase } from "./update-user-password-usecase";

import { updateUserPasswordSchema } from "@/schemas/update-user-password-schema";

class UpdateUserPasswordController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { currentPassword, newPassword } = updateUserPasswordSchema.parse(
      request.body,
    );

    const updateUserPasswordUseCase = container.resolve(
      UpdateUserPasswordUseCase,
    );

    await updateUserPasswordUseCase.execute({
      userId: id,
      currentPassword,
      newPassword,
    });

    return reply.status(200).send({ message: "Senha atualizada com sucesso" });
  }
}

export { UpdateUserPasswordController };
