import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeletePartUseCase } from "./delete-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeletePartSchema } from "@/schemas/update-delete-part-schema";

import { PartNotBelongServiceOrderError } from "../errors/part-not-belong-service-order-error";
import { PartHasAssociatedServiceOrderPartsError } from "../errors/part-has-associated-service-order-parts-error";

import { PartNotFoundError } from "../errors/part-not-found-error";

class DeletePartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { partId } = updateDeletePartSchema.parse(request.params);

    const deletePartUseCase = container.resolve(DeletePartUseCase);

    try {
      await deletePartUseCase.execute(partId, id, businessId);

      return reply.status(200).send({ message: "Peça deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PartNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PartNotBelongServiceOrderError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PartHasAssociatedServiceOrderPartsError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeletePartController };
