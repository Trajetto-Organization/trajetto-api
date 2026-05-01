import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RequestBranchDeletionUseCase } from "./request-branch-deletion-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "../errors/branch-not-belong-business-error";

import { BranchHasChildrenError } from "../errors/branch-has-children-error";
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

    try {
      const result = await requestBranchDeletionUseCase.execute(
        branchId,
        businessId,
        id,
      );

      return reply.status(200).send(result);
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

      if (error instanceof BranchHasChildrenError) {
        return reply.status(409).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { RequestBranchDeletionController };
