import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateServiceOrderPartUseCase } from "./create-service-order-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { PartNotFoundError } from "@/modules/part/usecases/errors/part-not-found-error";

import { ServiceOrderPartAlreadyExistsError } from "../errors/service-order-part-already-exists-error";

import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";
import { PartNotBelongServiceOrderError } from "@/modules/part/usecases/errors/part-not-belong-service-order-error";

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
      await createServiceOrderPartUseCase.execute(
        {
          ...serviceOrderPartData,
          businessId,
          serviceOrderId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Peça adicionada à ordem de serviço com sucesso!" });
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

      if (error instanceof ServiceOrderPartAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PartNotBelongServiceOrderError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateServiceOrderPartController };
