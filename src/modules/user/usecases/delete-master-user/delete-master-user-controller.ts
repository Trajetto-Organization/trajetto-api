import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteMasterUserUseCase } from "./delete-master-user-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserCannotBeDeletedByHimselfError } from "../errors/user-cannot-be-deleted-by-himself-error";
import { UserCannotDeleteLastMasterError } from "../errors/user-cannot-delete-last-master-error";

import { UserHasAssociatedServiceOrdersError } from "../errors/user-has-associated-service-orders-error";
import { UserHasAssociatedAccountPayablesError } from "../errors/user-has-associated-account-payables-error";

import { UserCannotDeleteMasterUserError } from "../errors/user-cannot-delete-master-user-error";
import { UserIsNotMasterError } from "../errors/user-is-not-master-error";

import { updateMasterUserParamsSchema } from "@/schemas/update-master-user-schema";

class DeleteMasterUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { masterUserId } = updateMasterUserParamsSchema.parse(request.params);

    const deleteMasterUserUseCase = container.resolve(DeleteMasterUserUseCase);

    try {
      await deleteMasterUserUseCase.execute({
        masterUserId,
        performedById: id,
      });

      return reply
        .status(200)
        .send({ message: "Usuário Master removido com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserCannotBeDeletedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserCannotDeleteLastMasterError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserHasAssociatedServiceOrdersError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserHasAssociatedAccountPayablesError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserCannotDeleteMasterUserError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserIsNotMasterError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteMasterUserController };
