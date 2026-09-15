import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ControlTowerUseCase } from "./control-tower-usecase";
import { controlTowerSchema } from "@/schemas/driver-position-schema";

class ControlTowerController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = controlTowerSchema.parse(request.query);

    const useCase = container.resolve(ControlTowerUseCase);

    const tower = await useCase.execute({ userId: id, businessId });

    return reply.status(200).send({ data: tower });
  }
}

export { ControlTowerController };
