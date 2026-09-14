import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteShipperUseCase } from "./delete-shipper-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
  ShipperHasDeliveriesError,
} from "../errors/shipper-errors";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteShipperSchema } from "@/schemas/update-delete-shipper-schema";

class DeleteShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { shipperId } = updateDeleteShipperSchema.parse(request.params);

    const deleteShipperUseCase = container.resolve(DeleteShipperUseCase);

    try {
      await deleteShipperUseCase.execute({
        userId: id,
        businessId,
        shipperId,
      });

      return reply
        .status(200)
        .send({ message: "Embarcador excluído com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperHasDeliveriesError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteShipperController };
