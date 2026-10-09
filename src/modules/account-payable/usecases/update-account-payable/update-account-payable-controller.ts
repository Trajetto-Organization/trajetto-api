import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateAccountPayableUseCase } from "./update-account-payable-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteAccountPayableSchema } from "@/schemas/update-delete-account-payable-schema";

import { updateAccountPayableSchema } from "@/schemas/update-account-payable-schema";

class UpdateAccountPayableController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { accountPayableId } = updateDeleteAccountPayableSchema.parse(
      request.params,
    );

    const accountPayableData = updateAccountPayableSchema.parse(request.body);
    const updateAccountPayableUseCase = container.resolve(
      UpdateAccountPayableUseCase,
    );

    // 404 ACCOUNT_PAYABLE_NOT_FOUND, 403 ACCOUNT_PAYABLE_TENANT_MISMATCH and
    // the 400s of the bill itself are AppErrors, answered with their code.
    const updated = await updateAccountPayableUseCase.execute(
      accountPayableData,
      accountPayableId,
      businessId,
      id,
    );

    return reply.status(200).send({
      message: "Conta a pagar atualizada com sucesso!",
      warnings: updated.warnings,
    });
  }
}

export { UpdateAccountPayableController };
