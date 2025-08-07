import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateAccountPayableUseCase } from "./update-account-payable-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";

import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";
import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteAccountPayableSchema } from "@/schemas/update-delete-account-payable-schema";

import { updateAccountPayableSchema } from "@/schemas/update-account-payable-schema";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

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

    try {
      await updateAccountPayableUseCase.execute(
        accountPayableData,
        accountPayableId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Conta a pagar atualizada com sucesso!" });
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

      if (error instanceof BranchNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof AccountPayableInvalidAmountError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateAccountPayableController };
