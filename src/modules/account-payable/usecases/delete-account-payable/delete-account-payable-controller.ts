import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteAccountPayableUseCase } from "./delete-account-payable-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteAccountPayableSchema } from "@/schemas/update-delete-account-payable-schema";

class DeleteAccountPayableController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { accountPayableId } = updateDeleteAccountPayableSchema.parse(
      request.params,
    );

    const deleteAccountPayableUseCase = container.resolve(
      DeleteAccountPayableUseCase,
    );

    // 404 ACCOUNT_PAYABLE_NOT_FOUND, 403 ACCOUNT_PAYABLE_TENANT_MISMATCH and
    // 409 ACCOUNT_PAYABLE_ALREADY_PAID are AppErrors, answered with their code.
    await deleteAccountPayableUseCase.execute(accountPayableId, businessId, id);

    return reply
      .status(200)
      .send({ message: "Conta a pagar deletada com sucesso!" });
  }
}

export { DeleteAccountPayableController };
