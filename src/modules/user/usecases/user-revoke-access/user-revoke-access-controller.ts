import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UserRevokeAccessUseCase } from "./user-revoke-access-usecase";

import { revokeUserAccessSchema } from "@/schemas/revoke-user-access-schema";

class UserRevokeAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { userId } = revokeUserAccessSchema.parse(request.params);
    const userRevokeAccessUseCase = container.resolve(UserRevokeAccessUseCase);

    await userRevokeAccessUseCase.execute({ userId, id });
    return reply.status(200).send({
      message: "Revogação de acesso atualizada com sucesso!",
    });
  }
}

export { UserRevokeAccessController };
