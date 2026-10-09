import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateMasterUserUseCase } from "./create-master-user-usecase";

import { createMasterUserSchema } from "@/schemas/create-master-user-schema";

class CreateMasterUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const userData = createMasterUserSchema.parse(request.body);
    const createMasterUserUseCase = container.resolve(CreateMasterUserUseCase);

    await createMasterUserUseCase.execute(userData, id);
    return reply
      .status(201)
      .send({ message: "Usuário Master criado com sucesso!" });
  }
}

export { CreateMasterUserController };
