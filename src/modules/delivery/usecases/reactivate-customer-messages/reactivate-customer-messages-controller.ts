import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

import { ReactivateCustomerMessagesUseCase } from "./reactivate-customer-messages-usecase";

class ReactivateCustomerMessagesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const data = await container
      .resolve(ReactivateCustomerMessagesUseCase)
      .execute({ userId: request.user.id, businessId, deliveryId });

    return reply.status(200).send({
      message: "Mensagens ao cliente reativadas.",
      data,
    });
  }
}

export { ReactivateCustomerMessagesController };
