import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateBranchUseCase } from "./create-branch-usecase";
import { createBranchSchema } from "@/schemas/create-branch-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateBranchController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const branchData = createBranchSchema.parse(request.body);
    const createBranchUseCase = container.resolve(CreateBranchUseCase);

    // Conflicts (409 BRANCH_*) are AppErrors: the error handler answers them
    // with their code, which the web shows verbatim.
    const created = await createBranchUseCase.execute(
      { ...branchData, businessId },
      businessId,
      id,
    );

    return reply
      .status(201)
      .send({ message: "Filial criada com sucesso!", id: created.id });
  }
}

export { CreateBranchController };
