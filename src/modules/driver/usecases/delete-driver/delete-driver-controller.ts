import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteDriverUseCase } from "./delete-driver-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDriverSchema } from "@/schemas/update-delete-driver-schema";

class DeleteDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { driverId } = updateDeleteDriverSchema.parse(request.params);

    const deleteDriverUseCase = container.resolve(DeleteDriverUseCase);

    // The history guards (fines, fuel, checklists, pauses, operation, a
    // linked user) are AppErrors: 409 with their code, from the global
    // handler.
    await deleteDriverUseCase.execute(driverId, id, businessId);

    return reply
      .status(200)
      .send({ message: "Motorista deletado com sucesso!" });
  }
}

export { DeleteDriverController };
