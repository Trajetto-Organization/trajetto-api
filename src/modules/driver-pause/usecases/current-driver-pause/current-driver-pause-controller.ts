import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CurrentDriverPauseUseCase } from "./current-driver-pause-usecase";

import { businessParam } from "../../schemas/driver-pause-schemas";
import { toPauseView } from "../../rules/pause-rules";

class CurrentDriverPauseController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = businessParam.parse(request.params);

    const useCase = container.resolve(CurrentDriverPauseUseCase);

    const current = await useCase.execute({
      businessId,
      driverId: request.user.driverId,
    });

    return reply.status(200).send({
      timeZone: current.timeZone,
      day: current.day,
      open: current.open ? toPauseView(current.open, current.typeNames) : null,
      today: current.today.map((pause) =>
        toPauseView(pause, current.typeNames),
      ),
      pause_allowed: current.pauseAllowed,
      journey_route_id: current.journeyRouteId,
    });
  }
}

export { CurrentDriverPauseController };
