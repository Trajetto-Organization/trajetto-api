import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDeliveryUseCase } from "./get-delivery-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class GetDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const getDeliveryUseCase = container.resolve(GetDeliveryUseCase);

    try {
      const delivery = await getDeliveryUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
      });

      return reply.status(200).send({ data: delivery });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DeliveryNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DeliveryNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetDeliveryController };
