import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateDeliveryUseCase } from "./create-delivery-usecase";

import { createDeliverySchema } from "@/schemas/create-delivery-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

class CreateDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const deliveryData = createDeliverySchema.parse(request.body);
    const createDeliveryUseCase = container.resolve(CreateDeliveryUseCase);

    const delivery = await createDeliveryUseCase.execute(
      {
        ...deliveryData,
        businessId,
        // Optional: the web form's key, so a resend is this same delivery.
        client_submission_id: idempotencyKeyOf(request.headers),
      },
      id,
    );

    return reply.status(201).send({
      message: "Entrega criada com sucesso!",
      data: { id: delivery.id },
    });
  }
}

export { CreateDeliveryController };
