import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { LiveRoutesUseCase } from "./live-routes-usecase";
import { liveRoutesSchema } from "@/schemas/driver-position-schema";

class LiveRoutesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, cursor } = liveRoutesSchema.parse(request.query);

    const useCase = container.resolve(LiveRoutesUseCase);

    const result = await useCase.execute({ userId: id, businessId, cursor });

    return reply.status(200).send(result);
  }
}

export { LiveRoutesController };
