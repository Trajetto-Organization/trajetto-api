import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { totalsWarning } from "../service-order-totals-warning";

import { CreateServiceOrderPartUseCase } from "./create-service-order-part-usecase";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { createServiceOrderPartSchema } from "@/schemas/create-service-order-part-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";

class CreateServiceOrderPartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { serviceOrderId } = updateDeleteServiceOrderSchema.parse(
      request.params,
    );

    const serviceOrderPartData = createServiceOrderPartSchema.parse(
      request.body,
    );

    const createServiceOrderPartUseCase = container.resolve(
      CreateServiceOrderPartUseCase,
    );

    try {
      const { totals } = await createServiceOrderPartUseCase.execute(
        {
          ...serviceOrderPartData,
          businessId,
          serviceOrderId,
        },
        id,
      );

      return reply.status(201).send({
        message: "Peça adicionada à ordem de serviço com sucesso!",
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

export { CreateServiceOrderPartController };
