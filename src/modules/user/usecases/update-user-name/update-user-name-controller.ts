import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateUserNameSchema } from "@/schemas/update-user-name-schema";

import { UpdateUserNameUseCase } from "./update-user-name-usecase";

class UpdateUserNameController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { name } = updateUserNameSchema.parse(request.body);

    const updateUserNameUseCase = container.resolve(UpdateUserNameUseCase);

    await updateUserNameUseCase.execute({
      name,
      userId: id,
    });

    return reply
      .status(200)
      .send({ message: "Nome de usuário atualizado com sucesso" });
  }
}

export { UpdateUserNameController };
