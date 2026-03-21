import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UserRevokeAccessUseCase } from "./user-revoke-access-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { revokeUserAccessSchema } from "@/schemas/revoke-user-access-schema";
import { UserCannotBeRevokeByHimselfError } from "../errors/user-cannot-be-revoke-access-by-himself-error";

class UserRevokeAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { userId } = revokeUserAccessSchema.parse(request.params);
    const userRevokeAccessUseCase = container.resolve(UserRevokeAccessUseCase);

    try {
      await userRevokeAccessUseCase.execute({ userId, id });
      return reply.status(200).send({
        message: "Revogação de acesso atualizada com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserCannotBeRevokeByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UserRevokeAccessController };
