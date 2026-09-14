import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateShipperUseCase } from "./create-shipper-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ShipperNameAlreadyExistsError } from "../errors/shipper-errors";
import { createShipperSchema } from "@/schemas/create-shipper-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const shipperData = createShipperSchema.parse(request.body);
    const createShipperUseCase = container.resolve(CreateShipperUseCase);

    try {
      await createShipperUseCase.execute({ ...shipperData, businessId }, id);

      return reply
        .status(201)
        .send({ message: "Embarcador criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateShipperController };
