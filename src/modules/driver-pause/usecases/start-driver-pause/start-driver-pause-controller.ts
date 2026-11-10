import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { StartDriverPauseUseCase } from "./start-driver-pause-usecase";

import {
  businessParam,
  startPauseBody,
} from "../../schemas/driver-pause-schemas";
import { toPauseView } from "../../rules/pause-rules";
import { PauseCooldownError } from "../errors/driver-pause-errors";

import {
  CLIENT_SENT_AT_HEADER,
  isOccurredAtStale,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";
import {
  CLIENT_QUEUED_AT_HEADER,
  CLIENT_VERSION_HEADER,
  isQueuedResend,
  parseClientVersion,
} from "@/shared/http/client-version";

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

    try {
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
        // From contract 5 on, a new start inside the cooldown is refused
        // instead of recorded, and from contract 7 on a generic "Outra
        // pausa" without its reason — unless the app's offline queue sent
        // it (X-Client-Queued-At): the tap happened earlier. The web and
        // the build in drivers' hands send neither.
        client: parseClientVersion(request.headers[CLIENT_VERSION_HEADER]),
        queued: isQueuedResend(request.headers[CLIENT_QUEUED_AT_HEADER]),
      });

      // 201 for the pause this request started, 200 for a resend of it.
      return reply
        .status(replayed ? 200 : 201)
        .send({ pause: toPauseView(pause, typeNames), replayed });
    } catch (error) {
      // The one refusal whose body carries more than code and message: the
      // cooldown, for the app's countdown. An AppError, so the global
      // handler would answer it too, but with code and message only.
      if (error instanceof PauseCooldownError) {
        return reply
          .header("x-error-code", error.code)
          .status(error.statusCode)
          .send({
            code: error.code,
            message: error.message,
            ...error.cooldown,
          });
      }

      throw error;
    }
  }
}

export { StartDriverPauseController };
