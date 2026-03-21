import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteServiceOrderUseCase } from "./delete-service-order-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";
import { ServiceOrderNotBelongBusinessError } from "../errors/service-order-not-belong-business-error";

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
      await deleteServiceOrderUseCase.execute(serviceOrderId, businessId, id);

      return reply
        .status(200)
        .send({ message: "Ordem de serviço deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteServiceOrderController };
