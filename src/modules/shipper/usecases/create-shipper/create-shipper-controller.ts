import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateShipperUseCase } from "./create-shipper-usecase";

import { createShipperSchema } from "@/schemas/create-shipper-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const shipperData = createShipperSchema.parse(request.body);
    const createShipperUseCase = container.resolve(CreateShipperUseCase);

    await createShipperUseCase.execute({ ...shipperData, businessId }, id);

    return reply
      .status(201)
      .send({ message: "Embarcador criado com sucesso!" });
  }
}

export { CreateShipperController };
