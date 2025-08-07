import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteBusinessUseCase } from "./delete-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

class DeleteBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const createUserUseCase = container.resolve(DeleteBusinessUseCase);

    try {
      await createUserUseCase.execute(businessId, id);
      return reply
        .status(200)
        .send({ message: "Empresa deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteBusinessController };
