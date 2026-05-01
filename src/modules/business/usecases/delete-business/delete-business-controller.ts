import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteBusinessUseCase } from "./delete-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BusinessHasChildrenError } from "@/modules/business/usecases/errors/business-has-children-error";

import { BusinessDeletionCodeInvalidError } from "../errors/business-deletion-code-invalid-error";
import { BusinessDeletionCodeExpiredError } from "../errors/business-deletion-code-expired-error";

import { BusinessNoPendingDeletionError } from "../errors/business-no-pending-deletion-error";

class DeleteBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { code } = confirmDeletionCodeSchema.parse(request.body);

    const deleteBusinessUseCase = container.resolve(DeleteBusinessUseCase);

    try {
      await deleteBusinessUseCase.execute(businessId, id, code);
      return reply
        .status(200)
        .send({ message: "Empresa deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof BusinessHasChildrenError) {
        return reply.status(409).send({ message: error.message });
      }

      if (error instanceof BusinessNoPendingDeletionError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessDeletionCodeExpiredError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessDeletionCodeInvalidError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteBusinessController };
