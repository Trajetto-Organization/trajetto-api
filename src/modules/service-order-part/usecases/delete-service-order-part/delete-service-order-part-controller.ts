import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteServiceOrderPartUseCase } from "./delete-service-order-part-usecase";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";

import { updateDeleteServiceOrderPartSchema } from "@/schemas/update-delete-service-order-part-schema";

class DeleteServiceOrderPartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { serviceOrderId } = updateDeleteServiceOrderSchema.parse(
      request.params,
    );

    const { serviceOrderPartId } = updateDeleteServiceOrderPartSchema.parse(
      request.params,
    );

    const deleteServiceOrderPartUseCase = container.resolve(
      DeleteServiceOrderPartUseCase,
    );

    try {
      await deleteServiceOrderPartUseCase.execute(
        serviceOrderPartId,
        serviceOrderId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Peça removida da ordem de serviço com sucesso!" });
    } catch (error) {
      // A missing or foreign order (404 SERVICE_ORDER_NOT_FOUND) and a
      // missing or foreign part (404 PART_NOT_FOUND) are AppErrors from the
      // use case, one answer each (decision 11.3).
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { DeleteServiceOrderPartController };
