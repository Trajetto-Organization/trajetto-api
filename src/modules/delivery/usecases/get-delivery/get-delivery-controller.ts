import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDeliveryUseCase } from "./get-delivery-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class GetDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const getDeliveryUseCase = container.resolve(GetDeliveryUseCase);

    const delivery = await getDeliveryUseCase.execute({
      userId: id,
      businessId,
      deliveryId,
    });

    return reply.status(200).send({ data: delivery });
  }
}

export { GetDeliveryController };
