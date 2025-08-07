import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { DeleteSupplierUseCase } from "./delete-supplier-usecase";
import { SupplierNotFoundError } from "../errors/supplier-not-found-error";

import { updateDeleteSupplierSchema } from "@/schemas/update-delete-supplier-schema";
import { SupplierNotBelongBusinessError } from "../errors/supplier-not-belong-business-error";

class DeleteSupplierController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { supplierId, businessId } = updateDeleteSupplierSchema.parse(
      request.params,
    );

    const deleteSupplierUseCase = container.resolve(DeleteSupplierUseCase);

    try {
      await deleteSupplierUseCase.execute(supplierId, businessId, id);

      return reply
        .status(200)
        .send({ message: "Fornecedor excluído com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof SupplierNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteSupplierController };
