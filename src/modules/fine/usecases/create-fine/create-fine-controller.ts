import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateFineUseCase } from "./create-fine-usecase";
import { createFineSchema } from "@/schemas/create-fine-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

import { sendFineError } from "../fine-http-errors";

class CreateFineController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const fineData = createFineSchema.parse(request.body);

    const createFineUseCase = container.resolve(CreateFineUseCase);

    try {
      await createFineUseCase.execute(
        {
          ...fineData,
          businessId,
          // Optional: the web form's key, so a resend is this same fine.
          client_submission_id: idempotencyKeyOf(request.headers),
        },
        id,
      );

      return reply.status(201).send({
        message: "Multa registrada com sucesso!",
      });
    } catch (error) {
      const handled = sendFineError(reply, error);

      if (handled) return handled;

      throw error;
    }
  }
}

export { CreateFineController };
