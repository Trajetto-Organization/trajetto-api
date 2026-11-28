import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import {
  ControlTowerUseCase,
  controlTowerSnapshot,
} from "./control-tower-usecase";
import { controlTowerSchema } from "@/schemas/driver-position-schema";
import {
  sendSnapshot,
  successBodyOf,
  wantsFreshSnapshot,
} from "@/shared/http/snapshot-reply";

class ControlTowerController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = controlTowerSchema.parse(request.query);

    const useCase = container.resolve(ControlTowerUseCase);

    // TOWER_SNAPSHOT_TTL_MS=0: the answer exactly as before the snapshot,
    // without ETag nor 304 (plano-escala F4-11).
    if (!controlTowerSnapshot.enabled) {
      const tower = await useCase.execute({ userId: id, businessId });

      return reply.status(200).send({ data: tower });
    }

    const toBody = successBodyOf(reply);

    const read = await useCase.executeSnapshot({
      userId: id,
      businessId,
      refresh: wantsFreshSnapshot(request),
      body: (tower) => toBody({ data: tower }),
    });

    return sendSnapshot(request, reply, read);
  }
}

export { ControlTowerController };
