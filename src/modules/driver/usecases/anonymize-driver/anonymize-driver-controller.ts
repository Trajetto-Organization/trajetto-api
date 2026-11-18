import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDriverSchema } from "@/schemas/update-delete-driver-schema";

import { AnonymizeDriverUseCase } from "./anonymize-driver-usecase";

class AnonymizeDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { driverId } = updateDeleteDriverSchema.parse(request.params);

    const { jobId } = await container
      .resolve(AnonymizeDriverUseCase)
      .execute({ driverId, businessId, userId: id });

    // 202: the job removes the data in a moment, on the process that runs
    // the `jobs` queue.
    return reply.status(202).send({
      message:
        "Remoção e anonimização do motorista agendadas. Os dados pessoais serão apagados em instantes.",
      jobId,
    });
  }
}

export { AnonymizeDriverController };
