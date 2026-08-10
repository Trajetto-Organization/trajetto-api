import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AuthenticateUserUseCase } from "./authenticate-user-usecase";
import { authenticateUserSchema } from "@/schemas/authenticate-user-schema";

import { UserInvalidCredentialsError } from "../errors/user-invalid-credentials-error";
import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";

import { UserRevokedAccessError } from "../errors/user-revoked-access-error";
import { UserDriverInactiveError } from "../errors/user-driver-inactive-error";

import { BusinessInactiveError } from "@/modules/business/usecases/errors/business-inactive-error";

class AuthenticateUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email, password } = authenticateUserSchema.parse(request.body);
    const authenticateUserUseCase = container.resolve(AuthenticateUserUseCase);

    try {
      const {
        twoFactorVerificationMessage,
        isTwoFactorVerification,
        emailVerification,
        emailVerificationMessage,
        token,
        refresh_token,
        role,
      } = await authenticateUserUseCase.execute({
        email,
        password,
      });

      if (emailVerificationMessage) {
        return reply.status(200).send({
          message: emailVerificationMessage,
          emailVerification: emailVerification,
        });
      }

      if (twoFactorVerificationMessage) {
        return reply.status(200).send({
          message: twoFactorVerificationMessage,
          twoFactorVerification: isTwoFactorVerification,
        });
      }

      return reply.status(200).send({
        message: "Usuário atutenticado com sucesso!",
        token,
        refresh_token,
        role,
      });
    } catch (error) {
      if (error instanceof UserInvalidCredentialsError) {
        return reply.status(401).send({
          code: "AUTH_INVALID_CREDENTIALS",
          message: error.message,
        });
      }

      if (error instanceof UserNotFoundPermissionOrProfileAccess) {
        return reply.status(403).send({
          code: "AUTH_PROFILE_NOT_CONFIGURED",
          message: error.message,
        });
      }

      if (error instanceof UserRevokedAccessError) {
        return reply.status(403).send({
          code: "AUTH_ACCESS_REVOKED",
          message: error.message,
        });
      }

      if (error instanceof UserDriverInactiveError) {
        return reply.status(403).send({
          code: "AUTH_DRIVER_INACTIVE",
          message: error.message,
        });
      }

      if (error instanceof BusinessInactiveError) {
        return reply.status(403).send({
          code: "AUTH_BUSINESS_INACTIVE",
          message: error.message,
        });
      }

      throw error;
    }
  }
}

export { AuthenticateUserController };
