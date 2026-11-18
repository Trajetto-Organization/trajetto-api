import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { scheduleBusinessPurgeSchema } from "@/schemas/schedule-business-purge-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { ScheduleBusinessPurgeUseCase } from "./schedule-business-purge-usecase";

class ScheduleBusinessPurgeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { confirmation } = scheduleBusinessPurgeSchema.parse(request.body);

    const business = await container
      .resolve(ScheduleBusinessPurgeUseCase)
      .execute({ businessId, userId: id, confirmation });

    return reply.status(200).send({
      message:
        "Exclusão agendada: a empresa foi desativada e os administradores foram avisados.",
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

export { ScheduleBusinessPurgeController };
