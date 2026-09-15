import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteStatusChangeReasonUseCase } from "./delete-status-change-reason-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  StatusChangeReasonInUseError,
  StatusChangeReasonNotBelongBusinessError,
  StatusChangeReasonNotFoundError,
} from "../errors/status-change-reason-errors";

import { updateDeleteStatusChangeReasonSchema } from "@/schemas/update-delete-status-change-reason-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class DeleteStatusChangeReasonController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { reasonId } = updateDeleteStatusChangeReasonSchema.parse(
      request.params,
    );

    const deleteStatusChangeReasonUseCase = container.resolve(
      DeleteStatusChangeReasonUseCase,
    );

    try {
      await deleteStatusChangeReasonUseCase.execute(reasonId, businessId, id);

      return reply
        .status(200)
        .send({ message: "Motivo excluído com sucesso!" });
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof StatusChangeReasonNotFoundError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      // 409, not 400: the request was well formed and the caller was allowed
      // to make it — the reason is simply part of the record now.
      if (error instanceof StatusChangeReasonInUseError) {
        return reply.status(409).send({ message: error.message });
      }

      if (error instanceof StatusChangeReasonNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteStatusChangeReasonController };
