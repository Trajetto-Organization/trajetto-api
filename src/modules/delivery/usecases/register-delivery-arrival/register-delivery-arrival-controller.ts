import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RegisterDeliveryArrivalUseCase } from "./register-delivery-arrival-usecase";

import { deliveryArrivalSchema } from "@/schemas/delivery-arrival-schema";
import {
  CLIENT_SENT_AT_HEADER,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class RegisterDeliveryArrivalController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const { client_submission_id, latitude, longitude, occurred_at } =
      deliveryArrivalSchema.parse(request.body);

    // The tap, moved onto the server's clock by the phone's own send stamp.
    const occurredAt = resolveOccurredAt({
      occurredAt: occurred_at,
      clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
    });

    const registerDeliveryArrivalUseCase = container.resolve(
      RegisterDeliveryArrivalUseCase,
    );

    await registerDeliveryArrivalUseCase.execute({
      userId: id,
      businessId,
      deliveryId,
      client_submission_id,
      latitude,
      longitude,
      occurredAt,
    });

    return reply
      .status(201)
      .send({ message: "Chegada registrada com sucesso!" });
  }
}

export { RegisterDeliveryArrivalController };
