import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RequestBranchDeletionUseCase } from "./request-branch-deletion-usecase";

import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

class RequestBranchDeletionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId, branchId } = updateDeleteBranchSchema.parse(
      request.params,
    );

    const requestBranchDeletionUseCase = container.resolve(
      RequestBranchDeletionUseCase,
    );

    // BRANCH_NOT_FOUND (404, also for another company's branch) is an
    // AppError and reaches the error handler with its code.
    const result = await requestBranchDeletionUseCase.execute(
      branchId,
      businessId,
      id,
    );

    return reply.status(200).send(result);
  }
}

export { RequestBranchDeletionController };
