import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateServiceOrderUseCase } from "./create-service-order-usecase";
import { replyMaintenanceError } from "../errors/maintenance-http-errors";

import { createServiceOrderSchema } from "@/schemas/create-service-order-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

class CreateServiceOrderController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const serviceOrderData = createServiceOrderSchema.parse(request.body);
    const createServiceOrderUseCase = container.resolve(
      CreateServiceOrderUseCase,
    );

    try {
      await createServiceOrderUseCase.execute(
        {
          ...serviceOrderData,
          businessId,
          // Optional: the web form's key, so a resend is this same order.
          client_submission_id: idempotencyKeyOf(request.headers),
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Ordem de serviço criada com sucesso!" });
    } catch (error) {
      // Another company's vehicle, branch, supplier or responsible answers
      // like a missing one, with a code (decision 11.3).
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { CreateServiceOrderController };
