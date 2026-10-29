import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteShipperUseCase } from "./delete-shipper-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteShipperSchema } from "@/schemas/update-delete-shipper-schema";

class DeleteShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { shipperId } = updateDeleteShipperSchema.parse(request.params);

    const deleteShipperUseCase = container.resolve(DeleteShipperUseCase);

    await deleteShipperUseCase.execute({
      userId: id,
      businessId,
      shipperId,
    });

    return reply
      .status(200)
      .send({ message: "Embarcador excluído com sucesso!" });
  }
}

export { DeleteShipperController };
