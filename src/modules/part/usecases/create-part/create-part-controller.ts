import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreatePartUseCase } from "./create-part-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { PartAlreadyExistsError } from "../errors/part-already-exists-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { createPartSchema } from "@/schemas/create-part-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreatePartController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const partData = createPartSchema.parse(request.body);
    const createPartUseCase = container.resolve(CreatePartUseCase);

    try {
      await createPartUseCase.execute(
        {
          ...partData,
          businessId,
        },
        id,
      );

      return reply.status(201).send({ message: "Peça criada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
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

      throw error;
    }
  }
}

export { CreatePartController };
