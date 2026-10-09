import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateAccountPayableUseCase } from "./create-account-payable-usecase";

import { createAccountPayableSchema } from "@/schemas/create-account-payable-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

class CreateAccountPayableController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const accountPayableData = createAccountPayableSchema.parse(request.body);
    const createAccountPayableUseCase = container.resolve(
      CreateAccountPayableUseCase,
    );

    // The refusals of the bill itself (invalid reference, amount) are
    // AppErrors: the error handler answers them with their code.
    const created = await createAccountPayableUseCase.execute(
      {
        ...accountPayableData,
        businessId,
        // Optional: the web form's key, so a resend is this same bill.
        client_submission_id: idempotencyKeyOf(request.headers),
      },
      id,
    );

    return reply.status(201).send({
      message: "Conta a pagar criada com sucesso!",
      id: created.id,
      warnings: created.warnings,
    });
  }
}

export { CreateAccountPayableController };
