import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateMasterUserUseCase } from "./update-master-user-usecase";

import {
  updateMasterUserSchema,
  updateMasterUserParamsSchema,
} from "@/schemas/update-master-user-schema";

class UpdateMasterUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { masterUserId } = updateMasterUserParamsSchema.parse(request.params);

    const updateData = updateMasterUserSchema.parse(request.body);
    const updateMasterUserUseCase = container.resolve(UpdateMasterUserUseCase);

    await updateMasterUserUseCase.execute({
      masterUserId,
      data: updateData,
      performedById: id,
    });

    return reply
      .status(200)
      .send({ message: "Usuário Master atualizado com sucesso!" });
  }
}

export { UpdateMasterUserController };
