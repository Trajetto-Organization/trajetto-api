import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteAccountPayableUseCase } from "./delete-account-payable-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { AccountPayableNotNotBelongBusinessError } from "../errors/account-payable-not-belong-business-error";
import { AccountPayableNotDeleteHasAlreadyPaidError } from "../errors/account-payable-not-delete-has-already-paid-error";

import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";

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

    try {
      await deleteAccountPayableUseCase.execute(
        accountPayableId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Conta a pagar deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof AccountPayableNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof AccountPayableNotDeleteHasAlreadyPaidError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof AccountPayableNotNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteAccountPayableController };
