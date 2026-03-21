import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateMasterUserUseCase } from "./create-master-user-usecase";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserCannotCreateMasterUserError } from "../errors/user-cannot-create-master-user-error";

import { createMasterUserSchema } from "@/schemas/create-master-user-schema";

class CreateMasterUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const userData = createMasterUserSchema.parse(request.body);
    const createMasterUserUseCase = container.resolve(CreateMasterUserUseCase);

    try {
      await createMasterUserUseCase.execute(userData, id);
      return reply
        .status(201)
        .send({ message: "Usuário Master criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserCannotCreateMasterUserError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserAlreadyExistsError) {
        return reply.status(409).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateMasterUserController };
