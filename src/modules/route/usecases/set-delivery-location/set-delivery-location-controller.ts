import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SetDeliveryLocationUseCase } from "./set-delivery-location-usecase";

import {
  deliveryIdParamSchema,
  setDeliveryLocationSchema,
} from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class SetDeliveryLocationController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = deliveryIdParamSchema.parse(request.params);

    const body = setDeliveryLocationSchema.parse(request.body);

    const useCase = container.resolve(SetDeliveryLocationUseCase);

    const delivery = await useCase.execute({
      userId: id,
      businessId,
      deliveryId,
      point: body.clear
        ? null
        : { latitude: body.latitude!, longitude: body.longitude! },
    });

    return reply.status(200).send({
      message: body.clear
        ? "Localização removida."
        : "Localização da entrega fixada no mapa.",
      data: delivery,
    });
  }
}

export { SetDeliveryLocationController };
