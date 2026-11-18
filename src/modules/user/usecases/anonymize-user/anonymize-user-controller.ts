import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

import { AnonymizeUserUseCase } from "./anonymize-user-usecase";

class AnonymizeUserController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;
    const { userId } = updateDeleteUserSchema.parse(request.params);

    const { jobId } = await container
      .resolve(AnonymizeUserUseCase)
      .execute({ userId, callerId: id });

    // 202: the job removes the data in a moment, on the process that runs
    // the `jobs` queue.
    return reply.status(202).send({
      message:
        "Remoção e anonimização do usuário agendadas. Os dados pessoais serão apagados em instantes.",
      jobId,
    });
  }
}

export { AnonymizeUserController };
