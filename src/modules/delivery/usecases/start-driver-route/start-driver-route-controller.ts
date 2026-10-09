import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { StartDriverRouteUseCase } from "./start-driver-route-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { startDriverRouteSchema } from "@/schemas/start-driver-route-schema";
import {
  CLIENT_SENT_AT_HEADER,
  isOccurredAtStale,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";

class StartDriverRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    // The body is read leniently, so the shared lock is applied by hand: a
    // businessId is never advisory, it is somebody naming another company
    // (decision 16.100) and gets the same 400 as every other edit.
    const raw = request.body;
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).businessId !== undefined) {
      return reply.header("x-error-code", "VALIDATION_ERROR").status(400).send({
        code: "VALIDATION_ERROR",
        message: TENANT_MOVE_REFUSED,
        issues: [TENANT_MOVE_REFUSED],
      });
    }

    // Lenient on purpose (see startDriverRouteSchema): the body is optional
    // and only ever advisory, so an unreadable one is the same as none.
    const body = startDriverRouteSchema.safeParse(raw ?? {});

    const tap = {
      occurredAt: body.success ? body.data.occurred_at : undefined,
      clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
    };

    const occurredAt = resolveOccurredAt(tap);

    const startDriverRouteUseCase = container.resolve(StartDriverRouteUseCase);

    const { started } = await startDriverRouteUseCase.execute({
      userId: id,
      businessId,
      occurredAt,
      // Past the offline horizon the tap is not a time (null above), but
      // it is still known to be that old — see the use case.
      staleTap: isOccurredAtStale(tap),
    });

    return reply.status(200).send({
      message:
        started > 0
          ? "Rota iniciada com sucesso!"
          : "Nenhuma entrega pendente para iniciar.",
      data: { started },
    });
  }
}

export { StartDriverRouteController };
