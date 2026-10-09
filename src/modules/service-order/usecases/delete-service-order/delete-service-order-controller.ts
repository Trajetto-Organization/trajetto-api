import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteServiceOrderUseCase } from "./delete-service-order-usecase";
import { replyMaintenanceError } from "../errors/maintenance-http-errors";

import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class DeleteServiceOrderController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { serviceOrderId } = updateDeleteServiceOrderSchema.parse(
      request.params,
    );

    const deleteServiceOrderUseCase = container.resolve(
      DeleteServiceOrderUseCase,
    );

    try {
      const { partsRemoved } = await deleteServiceOrderUseCase.execute(
        serviceOrderId,
        businessId,
        id,
      );

      return reply.status(200).send({
        message: "Ordem de serviço deletada com sucesso!",
        partsRemoved,
      });
    } catch (error) {
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { DeleteServiceOrderController };
