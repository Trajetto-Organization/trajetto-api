import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ToggleBranchActiveUseCase } from "./toggle-branch-active-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";

import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

class ToggleBranchActiveController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId, branchId } = updateDeleteBranchSchema.parse(
      request.params,
    );

    const toggleBranchActiveUseCase = container.resolve(
      ToggleBranchActiveUseCase,
    );

    try {
      const branch = await toggleBranchActiveUseCase.execute(
        branchId,
        businessId,
        id,
      );

      return reply.status(200).send({
        message: `Filial ${branch.is_active ? "ativada" : "desativada"} com sucesso!`,
        is_active: branch.is_active,
      });
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

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ToggleBranchActiveController };
