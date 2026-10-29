import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkStopOnTheWayUseCase } from "./mark-stop-on-the-way-usecase";
import {
  markStopOnTheWayParams,
  markStopOnTheWaySchema,
} from "./mark-stop-on-the-way-schema";

import {
  CLIENT_SENT_AT_HEADER,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

class MarkStopOnTheWayController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, routeId, stopId } = markStopOnTheWayParams.parse(
      request.params,
    );

    const { client_submission_id, latitude, longitude, occurred_at } =
      markStopOnTheWaySchema.parse(request.body ?? {});

    const markStopOnTheWayUseCase = container.resolve(MarkStopOnTheWayUseCase);

    const marked = await markStopOnTheWayUseCase.execute({
      userId: id,
      businessId,
      routeId,
      stopId,
      client_submission_id,
      latitude,
      longitude,
      // The tap, moved onto the server's clock by the phone's send stamp.
      occurredAt: resolveOccurredAt({
        occurredAt: occurred_at,
        clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
      }),
    });

    return reply.status(200).send({
      message: "Parada marcada como a caminho.",
      data: marked,
    });
  }
}

export { MarkStopOnTheWayController };
