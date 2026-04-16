import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ToggleBusinessActiveUseCase } from "./toggle-business-active-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

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

    try {
      const business = await toggleBusinessActiveUseCase.execute(
        businessId,
        id,
      );

      return reply.status(200).send({
        message: `Empresa ${business.is_active ? "ativada" : "desativada"} com sucesso!`,
        is_active: business.is_active,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ToggleBusinessActiveController };
