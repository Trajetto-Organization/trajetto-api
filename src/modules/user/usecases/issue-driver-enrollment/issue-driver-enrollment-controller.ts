import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { driverLoginParamsSchema } from "@/schemas/driver-access-schema";

import { IssueDriverEnrollmentUseCase } from "./issue-driver-enrollment-usecase";

class IssueDriverEnrollmentController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { userId } = driverLoginParamsSchema.parse(request.params);

    const issued = await container
      .resolve(IssueDriverEnrollmentUseCase)
      .execute({ actorId: request.user.id, userId });

    // A credential while it lives: no cache anywhere between here and the
    // manager's screen.
    reply.header("cache-control", "no-store");

    return reply.status(201).send({
      qrToken: issued.qrToken,
      qrContent: issued.qrContent,
      accessCode: issued.accessCode,
      expiresAt: issued.expiresAt.toISOString(),
      expiresIn: issued.expiresIn,
    });
  }
}

export { IssueDriverEnrollmentController };
