import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateSupplierUseCase } from "./create-supplier-usecase";
import { createSupplierSchema } from "@/schemas/create-supplier-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { SupplierNameAlreadyExistsError } from "../errors/supplier-name-already-exists-error";
import { SupplierCnpjAlreadyExistsError } from "../errors/supplier-cnpj-already-exists-error";

import { SupplierEmailAlreadyExistsError } from "../errors/supplier-email-already-exists-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateSupplierController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const supplierData = createSupplierSchema.parse(request.body);
    const createSupplierUseCase = container.resolve(CreateSupplierUseCase);

    try {
      await createSupplierUseCase.execute({ ...supplierData, businessId }, id);
      return reply
        .status(201)
        .send({ message: "Fornecedor criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
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

      throw error;
    }
  }
}

export { CreateSupplierController };
