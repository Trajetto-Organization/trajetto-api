import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateUserUseCase } from "./update-user-usecase";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";

import { updateUserSchema } from "@/schemas/update-user-schema";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";

import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";
import { DriverAlreadyLinkedToUserError } from "../errors/driver-already-linked-to-user-error";

import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { UserMasterOnlyCanBeUpdatePasswordError } from "../errors/user-master-only-can-be-update-password-error";

import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

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

      if (error instanceof UserMasterOnlyCanBeUpdatePasswordError) {
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

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof DriverAlreadyLinkedToUserError) {
        return reply.status(409).send({ message: error.message });
      }

      if (error instanceof UserCannotHaveBothDriverAndProfileError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateUserController };
