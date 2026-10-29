import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateBusinessUseCase } from "./create-business-usecase";

import { createBusinessSchema } from "@/schemas/create-business-schema";

class CreateBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const businessData = createBusinessSchema.parse(request.body);
    const createBusinessUseCase = container.resolve(CreateBusinessUseCase);

    // Conflicts (409 BUSINESS_*_TAKEN, BRANCH_CNPJ_UNAVAILABLE) are
    // AppErrors: the error handler answers them with their code.
    await createBusinessUseCase.execute(businessData, id);
    return reply
      .status(201)
      .send({ message: "Empresa e filial matriz criadas com sucesso!" });
  }
}

export { CreateBusinessController };
