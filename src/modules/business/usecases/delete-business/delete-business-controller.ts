import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteBusinessUseCase } from "./delete-business-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";

class DeleteBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { code } = confirmDeletionCodeSchema.parse(request.body);

    const deleteBusinessUseCase = container.resolve(DeleteBusinessUseCase);

    await deleteBusinessUseCase.execute(businessId, id, code);
    return reply
      .status(200)
      .send({ message: "Empresa deletada com sucesso!" });
  }
}

export { DeleteBusinessController };
