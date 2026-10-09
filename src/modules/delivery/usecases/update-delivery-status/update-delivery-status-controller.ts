import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateDeliveryStatusUseCase } from "./update-delivery-status-usecase";

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
  }
}

export { UpdateDeliveryStatusController };
