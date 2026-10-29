import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListPendingAuthorizationsUseCase } from "./list-pending-authorizations-usecase";
import { listPendingAuthorizationsSchema } from "./occurrence-authorization-schemas";

class ListPendingAuthorizationsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = listPendingAuthorizationsSchema.parse(request.query);

    const useCase = container.resolve(ListPendingAuthorizationsUseCase);

    const result = await useCase.execute({ userId: id, businessId });

    return reply.status(200).send(result);
  }
}

export { ListPendingAuthorizationsController };
