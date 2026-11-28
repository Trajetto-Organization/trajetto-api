import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { LiveRoutesUseCase, liveRoutesSnapshot } from "./live-routes-usecase";
import { liveRoutesSchema } from "@/schemas/driver-position-schema";
import {
  sendSnapshot,
  successBodyOf,
  wantsFreshSnapshot,
} from "@/shared/http/snapshot-reply";

class LiveRoutesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, cursor } = liveRoutesSchema.parse(request.query);

    const useCase = container.resolve(LiveRoutesUseCase);

    // A page after a cursor, or TOWER_SNAPSHOT_TTL_MS=0: the answer exactly
    // as before the snapshot, without ETag nor 304 (plano-escala F4-11).
    if (cursor !== undefined || !liveRoutesSnapshot.enabled) {
      const result = await useCase.execute({ userId: id, businessId, cursor });

      return reply.status(200).send(result);
    }

    const toBody = successBodyOf(reply);

    const read = await useCase.executeSnapshot({
      userId: id,
      businessId,
      refresh: wantsFreshSnapshot(request),
      body: (page) => toBody({ ...page }),
    });

    return sendSnapshot(request, reply, read);
  }
}

export { LiveRoutesController };
