import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import {
  AssignDeliveriesUseCase,
  assignmentMessage,
} from "./assign-deliveries-usecase";

import { assignDeliveriesSchema } from "@/schemas/assign-deliveries-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

/**
 * No catch of its own: every refusal of the use case (and of create-route,
 * release-route, cancel-route and update-route under it) is an AppError with
 * its status and code, which the error handler answers as documented. The
 * per-class mapping that lived here matched errors nothing throws any more.
 */
class AssignDeliveriesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const body = assignDeliveriesSchema.parse(request.body);

    // Deprecated (decision 14.7, §4.10): the web adds deliveries to a route
    // and releases it as a separate gesture. Logged on every use so "14 days
    // without one" can be read from the logs before the endpoint goes.
    request.log.warn(
      { event: "assign_deliveries_deprecated_call", businessId, userId: id },
      "Deprecated endpoint: PATCH /delivery/assign-deliveries",
    );

    const assignDeliveriesUseCase = container.resolve(AssignDeliveriesUseCase);

    const result = await assignDeliveriesUseCase.execute({
      userId: id,
      businessId,
      ...body,
    });

    // The route id travels back so the client can offer to open what it
    // just created — the assignment is no longer a column change with
    // nothing to look at.
    return reply.status(200).send({
      message: assignmentMessage(result),
      data: {
        assigned: result.assigned,
        routeId: result.routeId,
        routeCode: result.routeCode,
      },
    });
  }
}

export { AssignDeliveriesController };
