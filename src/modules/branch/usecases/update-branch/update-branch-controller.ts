import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateBranchUseCase } from "./update-branch-usecase";
import { updateBranchSchema } from "@/schemas/update-branch-schema";

import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

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

    // BRANCH_NOT_FOUND (404) and the conflicts (409 BRANCH_*) are AppErrors
    // and reach the error handler with their code.
    await updateBranchUseCase.execute(branchData, branchId, businessId, id);
    return reply
      .status(200)
      .send({ message: "Filial atualizada com sucesso!" });
  }
}

export { UpdateBranchController };
