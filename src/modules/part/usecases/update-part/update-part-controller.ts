import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdatePartUseCase } from "./update-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { PartNotFoundError } from "../errors/part-not-found-error";
import { PartAlreadyExistsError } from "../errors/part-already-exists-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { updatePartSchema } from "@/schemas/update-part-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeletePartSchema } from "@/schemas/update-delete-part-schema";
import { PartNotBelongError } from "../errors/part-not-belong-error";

class UpdatePartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { partId } = updateDeletePartSchema.parse(request.params);

    const partData = updatePartSchema.parse(request.body);
    const updatePartUseCase = container.resolve(UpdatePartUseCase);

    try {
      await updatePartUseCase.execute(partData, partId, id, businessId);
      return reply
        .status(200)
        .send({ message: "Peça atualizada com sucesso!" });
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

      if (error instanceof SupplierNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PartAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PartNotBelongError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdatePartController };
