import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { CancelBusinessPurgeUseCase } from "./cancel-business-purge-usecase";

class CancelBusinessPurgeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const business = await container
      .resolve(CancelBusinessPurgeUseCase)
      .execute(businessId, id);

    return reply.status(200).send({
      message: "Exclusão cancelada: a empresa foi reativada.",
      data: {
        id: business.id,
        is_active: business.is_active,
        purge_state: business.purge_state ?? null,
        deactivated_at: business.deactivated_at ?? null,
        purge_after: business.purge_after ?? null,
      },
    });
  }
}

export { CancelBusinessPurgeController };
