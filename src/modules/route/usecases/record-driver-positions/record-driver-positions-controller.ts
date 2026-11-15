import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RecordDriverPositionsUseCase } from "./record-driver-positions-usecase";
import { env } from "@/env";
import { recordDriverPositionsSchema } from "@/schemas/driver-position-schema";
import {
  currentPressureLevel,
  positionsFlushAfterMs,
} from "@/shared/health/pressure-level";

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
      data: {
        ...result,
        // How long the app should wait before its next flush, from this
        // replica's pressure (plano-escala F2-26). Read in memory: the
        // statements of the flush stay what they were.
        nextFlushAfterMs: positionsFlushAfterMs(
          currentPressureLevel(),
          env.POSITIONS_FLUSH_AFTER_MS,
        ),
      },
    });
  }
}

export { RecordDriverPositionsController };
