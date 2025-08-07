import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateSupplierUseCase } from "./update-supplier-usecase";

import { updateDeleteSupplierSchema } from "@/schemas/update-delete-supplier-schema";
import { updateSupplierSchema } from "@/schemas/update-supplier-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { SupplierNotFoundError } from "../errors/supplier-not-found-error";
import { SupplierNameAlreadyExistsError } from "../errors/supplier-name-already-exists-error";

import { SupplierCnpjAlreadyExistsError } from "../errors/supplier-cnpj-already-exists-error";
import { SupplierEmailAlreadyExistsError } from "../errors/supplier-email-already-exists-error";

import { SupplierNotBelongBusinessError } from "../errors/supplier-not-belong-business-error";

class UpdateSupplierController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { supplierId, businessId } = updateDeleteSupplierSchema.parse(
      request.params,
    );

    const supplierData = updateSupplierSchema.parse(request.body);
    const updateSupplierUseCase = container.resolve(UpdateSupplierUseCase);

    try {
      await updateSupplierUseCase.execute(
        supplierData,
        supplierId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Fornecedor atualizado com sucesso!" });
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

      if (error instanceof SupplierNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierCnpjAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierEmailAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateSupplierController };
