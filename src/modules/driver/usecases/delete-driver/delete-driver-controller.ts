import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteDriverUseCase } from "./delete-driver-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { DriverNotFoundError } from "../errors/driver-not-found-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { DriverNotBelongBusinessError } from "../errors/driver-not-belong-business-error";
import { DriverHasAssociatedFinesError } from "../errors/driver-has-associated-fines-error";

import { updateDeleteDriverSchema } from "@/schemas/update-delete-driver-schema";

class DeleteDriverController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { driverId } = updateDeleteDriverSchema.parse(request.params);

    const deleteDriverUseCase = container.resolve(DeleteDriverUseCase);

    try {
      await deleteDriverUseCase.execute(driverId, id, businessId);

      return reply
        .status(200)
        .send({ message: "Motorista deletado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof DriverHasAssociatedFinesError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteDriverController };
