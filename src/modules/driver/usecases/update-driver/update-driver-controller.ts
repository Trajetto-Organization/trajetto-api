import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { UpdateDriverUseCase } from "./update-driver-usecase";

import { updateDriverSchema } from "@/schemas/update-driver-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDriverSchema } from "@/schemas/update-delete-driver-schema";

class UpdateDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { driverId } = updateDeleteDriverSchema.parse(request.params);

    // Validated and transformed by the route (see create-driver-controller).
    const driverData = request.body as z.infer<typeof updateDriverSchema>;

    const updateDriverUseCase = container.resolve(UpdateDriverUseCase);

    await updateDriverUseCase.execute(driverData, driverId, id, businessId);

    return reply
      .status(200)
      .send({ message: "Motorista atualizado com sucesso!" });
  }
}

export { UpdateDriverController };
