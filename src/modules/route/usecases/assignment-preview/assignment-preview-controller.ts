import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AssignmentPreviewUseCase } from "./assignment-preview-usecase";

import { assignmentPreviewSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

/** Thin, like the rest of the module: the use case's AppErrors are the answer. */
class AssignmentPreviewController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const query = assignmentPreviewSchema.parse(request.query);

    const assignmentPreviewUseCase = container.resolve(
      AssignmentPreviewUseCase,
    );

    const data = await assignmentPreviewUseCase.execute({
      userId: id,
      businessId,
      ...query,
    });

    return reply.status(200).send({ data });
  }
}

export { AssignmentPreviewController };
