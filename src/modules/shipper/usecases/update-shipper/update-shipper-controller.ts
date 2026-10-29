import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateShipperUseCase } from "./update-shipper-usecase";

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

    await updateShipperUseCase.execute({
      userId: id,
      businessId,
      shipperId,
      shipperData,
    });

    return reply
      .status(200)
      .send({ message: "Embarcador atualizado com sucesso!" });
  }
}

export { UpdateShipperController };
