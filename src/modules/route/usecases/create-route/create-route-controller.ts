import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateRouteUseCase } from "./create-route-usecase";

import { createRouteSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

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
      // The panel's key (decision 14.7, §4.7): a double click or a resend
      // after a lost answer gets the route the first call made.
      client_submission_id: idempotencyKeyOf(request.headers),
    });

    return reply.status(201).send({
      message: route.replayed
        ? "Esta rota já tinha sido criada."
        : "Rota criada com sucesso!",
      data: {
        id: route.id,
        code: route.code,
        stops: route.stops.length,
        planVersion: route.plan_version,
        replayed: route.replayed === true,
      },
    });
  }
}

export { CreateRouteController };
