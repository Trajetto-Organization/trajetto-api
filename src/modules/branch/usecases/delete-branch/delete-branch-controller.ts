import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteBranchUseCase } from "./delete-branch-usecase";

import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";
import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";

class DeleteBranchController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId, branchId } = updateDeleteBranchSchema.parse(
      request.params,
    );

    const { code } = confirmDeletionCodeSchema.parse(request.body);
    const deleteBranchUseCase = container.resolve(DeleteBranchUseCase);

    // BRANCH_NOT_FOUND (404, also for another company's branch) is an
    // AppError and reaches the error handler with its code.
    await deleteBranchUseCase.execute(branchId, businessId, id, code);
    return reply.status(200).send({ message: "Filial deletada com sucesso!" });
  }
}

export { DeleteBranchController };
