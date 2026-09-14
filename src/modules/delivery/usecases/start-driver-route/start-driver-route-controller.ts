import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { StartDriverRouteUseCase } from "./start-driver-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class StartDriverRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const startDriverRouteUseCase = container.resolve(StartDriverRouteUseCase);

    try {
      const { started } = await startDriverRouteUseCase.execute({
        userId: id,
        businessId,
      });

      return reply.status(200).send({
        message:
          started > 0
            ? "Rota iniciada com sucesso!"
            : "Nenhuma entrega pendente para iniciar.",
        data: { started },
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { StartDriverRouteController };
