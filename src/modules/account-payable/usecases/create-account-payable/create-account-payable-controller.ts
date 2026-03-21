import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateAccountPayableUseCase } from "./create-account-payable-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";

import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import { createAccountPayableSchema } from "@/schemas/create-account-payable-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

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

    try {
      await createAccountPayableUseCase.execute(
        {
          ...accountPayableData,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Conta a pagar criada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
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

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateAccountPayableController };
