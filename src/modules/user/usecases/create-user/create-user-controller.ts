import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateUserUseCase } from "./create-user-usecase";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";

import { createUserSchema } from "@/schemas/create-user-schema";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

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

export { CreateUserController };
