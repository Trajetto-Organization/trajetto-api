import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateShipperUseCase } from "./update-shipper-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ShipperNotFoundError,
  ShipperNameAlreadyExistsError,
  ShipperNotBelongBusinessError,
} from "../errors/shipper-errors";

import { updateShipperSchema } from "@/schemas/update-shipper-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteShipperSchema } from "@/schemas/update-delete-shipper-schema";

class UpdateShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { shipperId } = updateDeleteShipperSchema.parse(request.params);

    const shipperData = updateShipperSchema.parse(request.body);
    const updateShipperUseCase = container.resolve(UpdateShipperUseCase);

    try {
      await updateShipperUseCase.execute({
        userId: id,
        businessId,
        shipperId,
        shipperData,
      });

      return reply
        .status(200)
        .send({ message: "Embarcador atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateShipperController };
