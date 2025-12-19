import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteUserUseCase } from "./delete-user-usecase";

import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-by-himself-error";
import { UserHasAssociatedServiceOrdersError } from "../errors/user-has-associated-service-orders-error";

import { UserHasAssociatedAccountPayablesError } from "../errors/user-has-associated-account-payables-error";

class DeleteUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { userId } = updateDeleteUserSchema.parse(request.params);

    const deleteUserUseCase = container.resolve(DeleteUserUseCase);

    try {
      await deleteUserUseCase.execute({ userId, id });
      return reply
        .status(200)
        .send({ message: "Usuário deletado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserCannotBeDeletedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserHasAssociatedServiceOrdersError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserHasAssociatedAccountPayablesError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteUserController };
