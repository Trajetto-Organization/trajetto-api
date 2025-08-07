import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { twoFactorUserSchema } from "@/schemas/two-factor-schema";
import { InvalidTwoFactorCodeError } from "../errors/invalid-two-factor-code-error";

import { ExpiredCodeError } from "../errors/expired-code-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { TwoFactorVerificationUseCase } from "./two-factor-verification-usecase";
import { InvalidCodeForUserError } from "../errors/invalid-code-for-user-error";

import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";

class TwoFactorVerificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email, code } = twoFactorUserSchema.parse(request.body);

    const twoFactorVerificationUseCase = container.resolve(
      TwoFactorVerificationUseCase,
    );

    try {
      const { token, refresh_token, role } =
        await twoFactorVerificationUseCase.execute({
          email: email as string,
          twoFactorCode: code as string,
        });

      return reply.status(200).send({
        message: "Autenticação de dois fatores bem-sucedida!",
        token,
        refresh_token,
        role,
      });
    } catch (error) {
      if (error instanceof UserNotFoundPermissionOrProfileAccess) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof InvalidTwoFactorCodeError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ExpiredCodeError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof InvalidCodeForUserError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { TwoFactorVerificationController };
