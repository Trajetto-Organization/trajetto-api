import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListProofAuditsUseCase } from "./list-proof-audits-usecase";
import { listProofAuditsSchema } from "@/schemas/proof-audit-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListProofAuditsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, status, page, pageSize } = request.query as z.infer<
      typeof listProofAuditsSchema
    >;

    const useCase = container.resolve(ListProofAuditsUseCase);

    // Every refusal is an AppError with its code (a user row gone is 404
    // USER_NOT_FOUND), answered by the global handler before the stream opens.
    await sendAsNDJSON({
      reply,
      dataPromise: useCase.execute({
        userId: id,
        businessId,
        status,
        page,
        pageSize,
      }),
      page,
      pageSize,
    });
  }
}

export { ListProofAuditsController };
