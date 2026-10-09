import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { twoFactorUserSchema } from "@/schemas/two-factor-schema";
import { UserInvalidTwoFactorCodeError } from "../errors/user-invalid-two-factor-code-error";

import { UserExpiredCodeError } from "../errors/user-expired-code-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { TwoFactorVerificationUseCase } from "./two-factor-verification-usecase";
import { UserInvalidCodeForUserError } from "../errors/user-invalid-code-for-user-error";

import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";
import { parseSessionClient } from "../../services/session-service";

class TwoFactorVerificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email, code, challenge } = twoFactorUserSchema.parse(request.body);

    // How many callers still send no challenge: the signal for switching
    // TWO_FACTOR_CHALLENGE_REQUIRED on (WEB-07).
    if (!challenge) {
      request.log.info(
        { event: "auth.two_factor_without_challenge", step: "verify" },
        "Two-factor request without challenge",
      );
    }

    const twoFactorVerificationUseCase = container.resolve(
      TwoFactorVerificationUseCase,
    );

    try {
      const { token, refresh_token, role } =
        await twoFactorVerificationUseCase.execute(
          {
            email: email as string,
            twoFactorCode: code as string,
            challenge,
          },
          parseSessionClient(request.headers["x-trajetto-client"]),
        );

      return reply.status(200).send({
        message: "Autenticação de dois fatores bem-sucedida!",
        token,
        refresh_token,
        role,
      });
    } catch (error) {
      if (error instanceof UserNotFoundPermissionOrProfileAccess) {
        return reply.status(403).send({
          code: "AUTH_PROFILE_NOT_CONFIGURED",
          message: error.message,
        });
      }

      if (error instanceof UserInvalidTwoFactorCodeError) {
        return reply.status(400).send({
          code: "AUTH_2FA_CODE_INVALID",
          message: error.message,
        });
      }

      if (error instanceof UserExpiredCodeError) {
        return reply.status(400).send({
          code: "AUTH_2FA_CODE_EXPIRED",
          message: error.message,
        });
      }

      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({
          code: "AUTH_2FA_NOT_FOUND",
          message: error.message,
        });
      }

      if (error instanceof UserInvalidCodeForUserError) {
        return reply.status(400).send({
          code: "AUTH_2FA_USER_MISMATCH",
          message: error.message,
        });
      }

      throw error;
    }
  }
}

export { TwoFactorVerificationController };
