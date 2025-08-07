import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateUserPasswordUseCase } from "./update-user-password-usecase";
import { UserUpdateIsSamePasswordError } from "../errors/update-user-is-same-password-error";

import { updateUserPasswordSchema } from "@/schemas/update-user-password-schema";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UpdateUserPasswordNotMatchError } from "../errors/update-user-password-not-match-error";

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

    try {
      await updateUserPasswordUseCase.execute({
        userId: id,
        currentPassword,
        newPassword,
      });

      return reply
        .status(200)
        .send({ message: "Senha atualizada com sucesso" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UpdateUserPasswordNotMatchError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserUpdateIsSamePasswordError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateUserPasswordController };
