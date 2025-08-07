import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { createProfileAccessSchema } from "@/schemas/create-profile-access";
import { CreateProfileAccessUseCase } from "./create-profile-access-usecase";

import { ProfileAccessAlreadyExistsError } from "../errors/profile-access-already-exists-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class CreateProfileAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { name, businessId } = createProfileAccessSchema.parse(request.body);
    const createUserUseCase = container.resolve(CreateProfileAccessUseCase);

    try {
      await createUserUseCase.execute(
        {
          name,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Perfil de acesso criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateProfileAccessController };
