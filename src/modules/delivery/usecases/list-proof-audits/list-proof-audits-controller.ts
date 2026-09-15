import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListProofAuditsUseCase } from "./list-proof-audits-usecase";
import { listProofAuditsSchema } from "@/schemas/proof-audit-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListProofAuditsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, status, page, pageSize } = request.query as z.infer<
      typeof listProofAuditsSchema
    >;

    const useCase = container.resolve(ListProofAuditsUseCase);

    try {
      const auditsPromise = useCase.execute({
        userId: id,
        businessId,
        status,
        page,
        pageSize,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: auditsPromise,
        page,
        pageSize,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListProofAuditsController };
