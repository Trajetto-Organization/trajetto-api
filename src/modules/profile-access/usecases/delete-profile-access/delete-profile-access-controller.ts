import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteProfileAccessUseCase } from "./delete-profile-access-usecase";

import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ProfileAccessCannotBeDeletedByHimselfError } from "../errors/profile-access-cannot-be-deleted-by-himself-error";

class DeleteProfileAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { profileAccessId } = updateDeleteProfileAccessSchema.parse(
      request.params,
    );

    const deleteProfileAccessUseCase = container.resolve(
      DeleteProfileAccessUseCase,
    );

    try {
      await deleteProfileAccessUseCase.execute(profileAccessId, id);
      return reply
        .status(200)
        .send({ message: "Perfil de acesso deletado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessCannotBeDeletedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof ProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteProfileAccessController };
