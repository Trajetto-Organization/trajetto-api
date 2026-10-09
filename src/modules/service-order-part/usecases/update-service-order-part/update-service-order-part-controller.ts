import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { totalsWarning } from "../service-order-totals-warning";

import { UpdateServiceOrderPartUseCase } from "./update-service-order-part-usecase";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";

import { updateDeleteServiceOrderPartSchema } from "@/schemas/update-delete-service-order-part-schema";
import { updateServiceOrderPartSchema } from "@/schemas/update-service-order-part-schema";

class UpdateServiceOrderPartController {
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

    const serviceOrderPartData = updateServiceOrderPartSchema.parse(
      request.body,
    );

    const updateServiceOrderPartUseCase = container.resolve(
      UpdateServiceOrderPartUseCase,
    );

    try {
      const { totals } = await updateServiceOrderPartUseCase.execute(
        serviceOrderPartData,
        serviceOrderPartId,
        serviceOrderId,
        businessId,
        id,
      );

      return reply.status(200).send({
        message: "Peça da ordem de serviço atualizada com sucesso!",
        ...totalsWarning(totals),
      });
    } catch (error) {
      // A missing or foreign order (404 SERVICE_ORDER_NOT_FOUND) and a
      // missing or foreign part (404 PART_NOT_FOUND) are AppErrors from the
      // use case, one answer each (decision 11.3).
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { UpdateServiceOrderPartController };
