import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { CreateDriverUseCase } from "./create-driver-usecase";

import { createDriverSchema } from "@/schemas/create-driver-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    // Validated and transformed by the route: the CNH expiry is already a
    // Date, which the wire schema (a "YYYY-MM-DD" string) would now refuse.
    const driverData = request.body as z.infer<typeof createDriverSchema>;

    const createDriverUseCase = container.resolve(CreateDriverUseCase);

    await createDriverUseCase.execute(
      {
        ...driverData,
        businessId,
      },
      id,
    );

    return reply
      .status(201)
      .send({ message: "Motorista criado com sucesso!" });
  }
}

export { CreateDriverController };
