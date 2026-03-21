import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateMasterUserUseCase } from "./update-master-user-usecase";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserCannotUpdateMasterUserError } from "../errors/user-cannot-update-master-user-error";

import { UserIsNotMasterError } from "../errors/user-is-not-master-error";
import {
  updateMasterUserSchema,
  updateMasterUserParamsSchema,
} from "@/schemas/update-master-user-schema";

class UpdateMasterUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { masterUserId } = updateMasterUserParamsSchema.parse(request.params);

    const updateData = updateMasterUserSchema.parse(request.body);
    const updateMasterUserUseCase = container.resolve(UpdateMasterUserUseCase);

    try {
      await updateMasterUserUseCase.execute({
        masterUserId,
        data: updateData,
        performedById: id,
      });

      return reply
        .status(200)
        .send({ message: "Usuário Master atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserCannotBeUpdatedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserCannotUpdateMasterUserError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserAlreadyExistsError) {
        return reply.status(409).send({ message: error.message });
      }

      if (error instanceof UserIsNotMasterError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateMasterUserController };
