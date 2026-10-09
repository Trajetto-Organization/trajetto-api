import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { createProfileAccessSchema } from "@/schemas/create-profile-access";
import { CreateProfileAccessUseCase } from "./create-profile-access-usecase";

class CreateProfileAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { name, businessId } = createProfileAccessSchema.parse(request.body);
    const createProfileAccessUseCase = container.resolve(
      CreateProfileAccessUseCase,
    );

    await createProfileAccessUseCase.execute(
      {
        name,
        businessId,
      },
      id,
    );

    return reply
      .status(201)
      .send({ message: "Perfil de acesso criado com sucesso!" });
  }
}

export { CreateProfileAccessController };
