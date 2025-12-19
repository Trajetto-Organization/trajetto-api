import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateServiceOrderPartUseCase } from "./update-service-order-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { PartNotFoundError } from "@/modules/part/usecases/errors/part-not-found-error";

import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";
import { ServiceOrderPartNotFoundError } from "../errors/service-order-part-not-found-error";

import { ServiceOrderPartAlreadyExistsError } from "../errors/service-order-part-already-exists-error";
import { PartNotBelongError } from "@/modules/part/usecases/errors/part-not-belong-error";

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
      await updateServiceOrderPartUseCase.execute(
        serviceOrderPartData,
        serviceOrderPartId,
        serviceOrderId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Peça da ordem de serviço atualizada com sucesso!" });
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

      if (error instanceof PartNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderPartNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderPartAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PartNotBelongError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateServiceOrderPartController };
