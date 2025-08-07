import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateProfileAccessUseCase } from "./update-profile-access-usecase";

import { updateProfileAccessSchema } from "@/schemas/update-profile-access";
import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ProfileAccessAlreadyExistsError } from "../errors/profile-access-already-exists-error";

import { ProfileAccessCannotBeUpdatedByHimselfError } from "../errors/profile-access-cannot-be-updated-by-himself-error";

class UpdateProfileAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { profileAccessId } = updateDeleteProfileAccessSchema.parse(
      request.params,
    );

    const { businessId, name } = updateProfileAccessSchema.parse(request.body);

    const updateProfileAccessUseCase = container.resolve(
      UpdateProfileAccessUseCase,
    );

    try {
      await updateProfileAccessUseCase.execute(
        {
          profileAccessId,
          businessId,
          name,
        },
        id,
      );

      return reply
        .status(200)
        .send({ message: "Perfil de acesso atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessCannotBeUpdatedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateProfileAccessController };
