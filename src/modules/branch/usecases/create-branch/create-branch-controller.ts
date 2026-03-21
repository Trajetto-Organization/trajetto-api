import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateBranchUseCase } from "./create-branch-usecase";
import { createBranchSchema } from "@/schemas/create-branch-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BranchNameAlreadyExistsError } from "../errors/branch-name-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "../errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "../errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "../errors/branch-email-already-exists-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { BusinessCnpjAlreadyExistsError } from "@/modules/business/usecases/errors/business-cnpj-already-exists-error";
import { BusinessCorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/business-corporate-reason-already-exists-error";

import { BusinessErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/business-erp-code-already-exists-error";
import { BusinessEmailAlreadyExistsError } from "@/modules/business/usecases/errors/business-email-already-exists-error";

class CreateBranchController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const branchData = createBranchSchema.parse(request.body);
    const createBranchUseCase = container.resolve(CreateBranchUseCase);

    try {
      await createBranchUseCase.execute(
        { ...branchData, businessId },
        businessId,
        id,
      );

      return reply.status(201).send({ message: "Filial criada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchCnpjAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchErpCodeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchEmailAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessCnpjAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessCorporateReasonAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessErpCodeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessEmailAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateBranchController };
