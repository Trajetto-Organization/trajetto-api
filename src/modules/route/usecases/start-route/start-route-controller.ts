import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { StartRouteUseCase } from "./start-route-usecase";

import { routeIdParamSchema, startRouteSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import {
  CLIENT_SENT_AT_HEADER,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";

class StartRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { vehicleId, occurred_at } = startRouteSchema.parse(
      request.body ?? {},
    );

    const startRouteUseCase = container.resolve(StartRouteUseCase);

    const route = await startRouteUseCase.execute({
      userId: id,
      businessId,
      routeId,
      vehicleId,
      // The tap, moved onto the server's clock by the phone's send stamp.
      occurredAt: resolveOccurredAt({
        occurredAt: occurred_at,
        clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
      }),
    });

    return reply.status(200).send({
      message: "Rota iniciada!",
      data: { id: route.id, started_at: route.started_at },
    });
  }
}

export { StartRouteController };
