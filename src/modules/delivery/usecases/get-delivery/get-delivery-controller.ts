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

    // `{ data, meta: { timeZone } }`: the company's zone beside the detail
    // (decision D22), additive for every reader of `data`.
    const answer = await getDeliveryUseCase.read({
      userId: id,
      businessId,
      deliveryId,
    });

    return reply.status(200).send(answer);
  }
}

export { GetDeliveryController };
