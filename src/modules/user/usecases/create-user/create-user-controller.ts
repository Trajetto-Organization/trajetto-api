import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateUserUseCase } from "./create-user-usecase";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { BusinessNotFoundError } from "../../../business/usecases/errors/business-not-found-error";
import { UserProfileAccessNotFoundError } from "../errors/user-profile-access-not-found-error";

import { createUserSchema } from "@/schemas/create-user-schema";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { UserDriverAlreadyLinkedToUserError } from "../errors/user-driver-already-linked-to-user-error";
import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { UserOnlyMasterBeAbleSetPasswordError } from "../errors/user-only-master-be-able-set-password-error";

class CreateUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const userData = createUserSchema.parse(request.body);
    const createUserUseCase = container.resolve(CreateUserUseCase);

    try {
      await createUserUseCase.execute(userData, id);
      return reply.status(201).send({ message: "Usuário criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserProfileNotMatchBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserAlreadyExistsError) {
        return reply.status(409).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserOnlyMasterBeAbleSetPasswordError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserDriverAlreadyLinkedToUserError) {
        return reply.status(409).send({ message: error.message });
      }

      if (error instanceof UserCannotHaveBothDriverAndProfileError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateUserController };
