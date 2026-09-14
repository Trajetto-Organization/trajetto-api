import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RegisterDeliveryProofUseCase } from "./register-delivery-proof-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

import { deliveryProofSchema } from "@/schemas/delivery-proof-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class RegisterDeliveryProofController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const {
      client_submission_id,
      photo,
      signature,
      received_by,
      latitude,
      longitude,
    } = deliveryProofSchema.parse(request.body);

    const registerDeliveryProofUseCase = container.resolve(
      RegisterDeliveryProofUseCase,
    );

    try {
      await registerDeliveryProofUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        client_submission_id,
        photo,
        signature,
        received_by,
        latitude,
        longitude,
      });

      return reply
        .status(201)
        .send({ message: "Entrega comprovada com sucesso!" });
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

export { RegisterDeliveryProofController };
