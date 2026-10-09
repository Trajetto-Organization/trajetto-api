import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ToggleBusinessActiveUseCase } from "./toggle-business-active-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ToggleBusinessActiveController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const toggleBusinessActiveUseCase = container.resolve(
      ToggleBusinessActiveUseCase,
    );

    const business = await toggleBusinessActiveUseCase.execute(
      businessId,
      id,
    );

    return reply.status(200).send({
      message: `Empresa ${business.is_active ? "ativada" : "desativada"} com sucesso!`,
      is_active: business.is_active,
    });
  }
}

export { ToggleBusinessActiveController };
