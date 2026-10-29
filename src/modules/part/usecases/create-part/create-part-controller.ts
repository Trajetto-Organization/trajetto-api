import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreatePartUseCase } from "./create-part-usecase";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { createPartSchema } from "@/schemas/create-part-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreatePartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const partData = createPartSchema.parse(request.body);
    const createPartUseCase = container.resolve(CreatePartUseCase);

    try {
      await createPartUseCase.execute(
        {
          ...partData,
          businessId,
        },
        id,
      );

      return reply.status(201).send({ message: "Peça criada com sucesso!" });
    } catch (error) {
      // Another company's supplier answers like a missing one (decision
      // 11.3); the part's own errors are AppErrors the global handler sends.
      if (replyMaintenanceError(reply, error)) return reply;

      throw error;
    }
  }
}

export { CreatePartController };
