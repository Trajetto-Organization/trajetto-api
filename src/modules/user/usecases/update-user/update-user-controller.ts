import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateUserUseCase } from "./update-user-usecase";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";

import { updateUserSchema } from "@/schemas/update-user-schema";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";

import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

class UpdateUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { userId } = updateDeleteUserSchema.parse(request.params);

    const userData = updateUserSchema.parse(request.body);
    const updateUserUseCase = container.resolve(UpdateUserUseCase);

    try {
      await updateUserUseCase.execute(
        {
          userId,
          userData,
        },
        id,
      );

      return reply
        .status(200)
        .send({ message: "Usuário atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserCannotBeUpdatedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserProfileNotMatchBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserAlreadyExistsError) {
        return reply.status(409).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateUserController };
