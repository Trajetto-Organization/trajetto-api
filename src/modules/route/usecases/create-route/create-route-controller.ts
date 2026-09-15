import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateRouteUseCase } from "./create-route-usecase";

import { createRouteSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

/**
 * Controllers in this module are thin on purpose: every refusal the route use
 * cases raise is already an AppError carrying its own status and code, and the
 * error handler in http.ts turns those into the response. A try/catch here
 * would only be able to re-wrap them less accurately.
 */
class CreateRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const body = createRouteSchema.parse(request.body);

    const createRouteUseCase = container.resolve(CreateRouteUseCase);

    const route = await createRouteUseCase.execute({
      userId: id,
      businessId,
      ...body,
    });

    return reply.status(201).send({
      message: "Rota criada com sucesso!",
      data: { id: route.id, code: route.code, stops: route.stops.length },
    });
  }
}

export { CreateRouteController };
