import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RecordDriverPositionsUseCase } from "./record-driver-positions-usecase";
import { recordDriverPositionsSchema } from "@/schemas/driver-position-schema";

class RecordDriverPositionsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { pings } = recordDriverPositionsSchema.parse(request.body);

    const useCase = container.resolve(RecordDriverPositionsUseCase);

    const result = await useCase.execute({ userId: id, pings });

    return reply.status(200).send({
      message: result.tracking
        ? "Posições registradas."
        : "Nenhuma rota em andamento; rastreamento encerrado.",
      data: result,
    });
  }
}

export { RecordDriverPositionsController };
