import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateBusinessUseCase } from "./update-business-usecase";

import { updateBusinessSchema } from "@/schemas/update-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class UpdateBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const businessData = updateBusinessSchema.parse(request.body);
    const updateBusinessUseCase = container.resolve(UpdateBusinessUseCase);

    // Conflicts (409 BUSINESS_*_TAKEN and the head office's BRANCH_*) are
    // AppErrors: the error handler answers them with their code.
    await updateBusinessUseCase.execute({
      userId: id,
      businessId,
      businessData,
    });

    return reply
      .status(200)
      .send({ message: "Empresa atualizada com sucesso!" });
  }
}

export { UpdateBusinessController };
