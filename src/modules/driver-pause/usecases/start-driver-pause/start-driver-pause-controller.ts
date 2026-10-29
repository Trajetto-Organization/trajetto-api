import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { StartDriverPauseUseCase } from "./start-driver-pause-usecase";

import {
  businessParam,
  startPauseBody,
} from "../../schemas/driver-pause-schemas";
import { toPauseView } from "../../rules/pause-rules";

import {
  CLIENT_SENT_AT_HEADER,
  isOccurredAtStale,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

class StartDriverPauseController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = businessParam.parse(request.params);

    // Validated and transformed by the route already (the note is cleaned).
    const body = request.body as z.infer<typeof startPauseBody>;

    // The tap in the street, moved onto the server's clock by the phone's
    // own send stamp: a pause queued offline keeps the time it began.
    const tap = {
      occurredAt: body.occurred_at,
      clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
    };

    const startedAt = resolveOccurredAt(tap);

    const useCase = container.resolve(StartDriverPauseUseCase);

    const { pause, replayed, typeNames } = await useCase.execute({
      businessId,
      driverId: request.user.driverId,
      kind: body.kind,
      occurrenceTypeId: body.occurrence_type_id,
      startSubmissionId: body.start_submission_id,
      startedAt,
      staleTap: isOccurredAtStale(tap),
      latitude: body.latitude,
      longitude: body.longitude,
      note: body.note,
    });

    // 201 for the pause this request started, 200 for a resend of it.
    return reply
      .status(replayed ? 200 : 201)
      .send({ pause: toPauseView(pause, typeNames), replayed });
  }
}

export { StartDriverPauseController };
