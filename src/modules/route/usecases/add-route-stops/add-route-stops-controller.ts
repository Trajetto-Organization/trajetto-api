import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AddRouteStopsUseCase } from "./add-route-stops-usecase";

import { addRouteStopsSchema, routeIdParamSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class AddRouteStopsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { deliveryIds, expectedPlanVersion } = addRouteStopsSchema.parse(
      request.body,
    );

    const addRouteStopsUseCase = container.resolve(AddRouteStopsUseCase);

    const { stops, alreadyOnRoute, planVersion } =
      await addRouteStopsUseCase.execute({
        userId: id,
        businessId,
        routeId,
        deliveryIds,
        expectedPlanVersion,
      });

    return reply.status(201).send({
      message: "Paradas adicionadas à rota!",
      data: {
        added: stops.length,
        stopIds: stops.map((stop) => stop.id),
        alreadyOnRoute,
        planVersion,
      },
    });
  }
}

export { AddRouteStopsController };
