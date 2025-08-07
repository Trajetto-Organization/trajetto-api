import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteServiceOrderPartUseCase } from "./delete-service-order-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { ServiceOrderPartNotFoundError } from "../errors/service-order-part-not-found-error";

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderPartNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteServiceOrderPartController };
