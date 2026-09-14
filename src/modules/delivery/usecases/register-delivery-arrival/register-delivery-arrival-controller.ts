import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RegisterDeliveryArrivalUseCase } from "./register-delivery-arrival-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

import { deliveryArrivalSchema } from "@/schemas/delivery-arrival-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class RegisterDeliveryArrivalController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const { client_submission_id, latitude, longitude } =
      deliveryArrivalSchema.parse(request.body);

    const registerDeliveryArrivalUseCase = container.resolve(
      RegisterDeliveryArrivalUseCase,
    );

    try {
      await registerDeliveryArrivalUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        client_submission_id,
        latitude,
        longitude,
      });

      return reply
        .status(201)
        .send({ message: "Chegada registrada com sucesso!" });
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

export { RegisterDeliveryArrivalController };
