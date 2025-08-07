import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateUserNameSchema } from "@/schemas/update-user-name-schema";

import { UpdateUserNameUseCase } from "./update-user-name-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserNameNotBeUpdatedError } from "../errors/user-name-not-be-updated-error";

class UpdateUserNameController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { name } = updateUserNameSchema.parse(request.body);

    const updateUserNameUseCase = container.resolve(UpdateUserNameUseCase);

    try {
      await updateUserNameUseCase.execute({
        name,
        userId: id,
      });

      return reply
        .status(200)
        .send({ message: "Nome de usuário atualizado com sucesso" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserNameNotBeUpdatedError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateUserNameController };
