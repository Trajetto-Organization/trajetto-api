import { FastifyReply, FastifyRequest } from "fastify";
import { JsonWebTokenError } from "jsonwebtoken";

import { container } from "tsyringe";
import { refreshTokenSchema } from "@/schemas/refresh-token-schema";

import { RefreshTokenNotExistsError } from "../errors/refresh-token-not-exists-error";
import { InvalidCredentialsError } from "../errors/invalid-credentials-error";

import { RefreshTokenUseCase } from "./refresh-token-usecase";

import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";
import { UserRevokedAccessError } from "../errors/user-revoked-access-error";

class RefreshTokenController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = refreshTokenSchema.parse(request.body);
    const refreshTokenUseCase = container.resolve(RefreshTokenUseCase);

    try {
      const { refresh_token, token: newToken } =
        await refreshTokenUseCase.execute(token);
      return reply.status(201).send({ refresh_token, token: newToken });
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserNotFoundPermissionOrProfileAccess) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserRevokedAccessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof RefreshTokenNotExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof JsonWebTokenError) {
        // Specific check for JsonWebTokenError
        return reply.status(401).send({
          message: "Assinatura de token inválida!",
        });
      }

      throw error;
    }
  }
}

export { RefreshTokenController };
