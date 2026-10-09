import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateDeliveryUseCase } from "./update-delivery-usecase";

import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class UpdateDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const deliveryData = updateDeliverySchema.parse(request.body);
    const updateDeliveryUseCase = container.resolve(UpdateDeliveryUseCase);

    await updateDeliveryUseCase.execute({
      userId: id,
      businessId,
      deliveryId,
      deliveryData,
    });

    return reply
      .status(200)
      .send({ message: "Entrega atualizada com sucesso!" });
  }
}

export { UpdateDeliveryController };
