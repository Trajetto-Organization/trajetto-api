import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ToggleBranchActiveUseCase } from "./toggle-branch-active-usecase";

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

    // BRANCH_NOT_FOUND (404, also for another company's branch) is an
    // AppError and reaches the error handler with its code.
    const branch = await toggleBranchActiveUseCase.execute(
      branchId,
      businessId,
      id,
    );

    return reply.status(200).send({
      message: `Filial ${branch.is_active ? "ativada" : "desativada"} com sucesso!`,
      is_active: branch.is_active,
    });
  }
}

export { ToggleBranchActiveController };
