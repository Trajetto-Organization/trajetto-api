import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { EndDriverPauseUseCase } from "./end-driver-pause-usecase";

import { businessParam, endPauseBody } from "../../schemas/driver-pause-schemas";
import { toPauseView } from "../../rules/pause-rules";

import {
  CLIENT_SENT_AT_HEADER,
  isOccurredAtStale,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

/** The start the end repeats, dated by the same phone clock as the end. */
function repeatedStart(
  start: NonNullable<z.infer<typeof endPauseBody>["start"]>,
  clientSentAt: unknown,
) {
  const tap = { occurredAt: start.occurred_at, clientSentAt };

  return {
    kind: start.kind,
    occurrenceTypeId: start.occurrence_type_id,
    startedAt: resolveOccurredAt(tap),
    staleTap: isOccurredAtStale(tap),
    latitude: start.latitude,
    longitude: start.longitude,
    note: start.note,
  };
}

class EndDriverPauseController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = businessParam.parse(request.params);

    const body = request.body as z.infer<typeof endPauseBody>;

    // Both taps (the end, and the start it may repeat) came from the same
    // phone clock, so the same send stamp corrects both.
    const clientSentAt = request.headers[CLIENT_SENT_AT_HEADER];

    const endTap = { occurredAt: body.occurred_at, clientSentAt };

    const useCase = container.resolve(EndDriverPauseUseCase);

    const { pause, replayed, typeNames } = await useCase.execute({
      businessId,
      driverId: request.user.driverId,
      startSubmissionId: body.start_submission_id,
      endSubmissionId: body.end_submission_id,
      endedAt: resolveOccurredAt(endTap),
      staleTap: isOccurredAtStale(endTap),
      latitude: body.latitude,
      longitude: body.longitude,
      start: body.start ? repeatedStart(body.start, clientSentAt) : undefined,
    });

    return reply.status(200).send({ pause: toPauseView(pause, typeNames), replayed });
  }
}

export { EndDriverPauseController };
