import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AuthenticateUserUseCase } from "./authenticate-user-usecase";
import { authenticateUserSchema } from "@/schemas/authenticate-user-schema";

import { InvalidCredentialsError } from "../errors/invalid-credentials-error";
import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";

import { UserRevokedAccessError } from "../errors/user-revoked-access-error";

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
      if (error instanceof InvalidCredentialsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserNotFoundPermissionOrProfileAccess) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserRevokedAccessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { AuthenticateUserController };
