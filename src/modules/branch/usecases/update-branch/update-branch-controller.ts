import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateBranchUseCase } from "./update-branch-usecase";
import { updateBranchSchema } from "@/schemas/update-branch-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { BranchCnpjAlreadyExistsError } from "../errors/branch-cnpj-already-exists-error";

import { BranchErpCodeAlreadyExistsError } from "../errors/branch-erp-code-already-exists-error";
import { BranchEmailAlreadyExistsError } from "../errors/branch-email-already-exists-error";

import { BranchNameAlreadyExistsError } from "../errors/branch-name-already-exists-error";
import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

import { BusinessCnpjAlreadyExistsError } from "@/modules/business/usecases/errors/business-cnpj-already-exists-error";
import { BusinessCorporateReasonAlreadyExistsError } from "@/modules/business/usecases/errors/business-corporate-reason-already-exists-error";

import { BusinessErpCodeAlreadyExistsError } from "@/modules/business/usecases/errors/business-erp-code-already-exists-error";
import { BusinessEmailAlreadyExistsError } from "@/modules/business/usecases/errors/business-email-already-exists-error";

import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";

class UpdateBranchController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { branchId, businessId } = updateDeleteBranchSchema.parse(
      request.params,
    );

    const branchData = updateBranchSchema.parse(request.body);
    const updateBranchUseCase = container.resolve(UpdateBranchUseCase);

    try {
      await updateBranchUseCase.execute(branchData, branchId, businessId, id);
      return reply
        .status(200)
        .send({ message: "Filial atualizada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof BranchCnpjAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNameAlreadyExistsError) {
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

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateBranchController };
