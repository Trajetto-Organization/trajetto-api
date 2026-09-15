import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateDeliveryStatusUseCase } from "./update-delivery-status-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

import { updateDeliveryStatusSchema } from "@/schemas/update-delivery-status-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class UpdateDeliveryStatusController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const { status, received_by, reasonId, note } =
      updateDeliveryStatusSchema.parse(request.body);

    const updateDeliveryStatusUseCase = container.resolve(
      UpdateDeliveryStatusUseCase,
    );

    try {
      await updateDeliveryStatusUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        status,
        received_by,
        reasonId,
        note,
      });

      return reply
        .status(200)
        .send({ message: "Status da entrega atualizado com sucesso!" });
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

export { UpdateDeliveryStatusController };
