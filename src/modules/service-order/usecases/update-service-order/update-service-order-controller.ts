import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateServiceOrderUseCase } from "./update-service-order-usecase";
import { replyMaintenanceError } from "../errors/maintenance-http-errors";

import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateServiceOrderSchema } from "@/schemas/update-service-order-schema";

class UpdateServiceOrderController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { serviceOrderId } = updateDeleteServiceOrderSchema.parse(
      request.params,
    );

    const serviceOrderData = updateServiceOrderSchema.parse(request.body);
    const updateServiceOrderUseCase = container.resolve(
      UpdateServiceOrderUseCase,
    );

    try {
      await updateServiceOrderUseCase.execute(
        serviceOrderData,
        serviceOrderId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Ordem de serviço atualizada com sucesso!" });
    } catch (error) {
      // A missing or foreign order is a 404 SERVICE_ORDER_NOT_FOUND from
      // the use case; foreign links in the body answer like missing ones.
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { UpdateServiceOrderController };
