import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AuthenticateUserUseCase } from "./authenticate-user-usecase";
import { sessionLoginSchema } from "@/schemas/authenticate-user-schema";

import { UserInvalidCredentialsError } from "../errors/user-invalid-credentials-error";
import { UserNotFoundPermissionOrProfileAccess } from "../errors/user-not-found-permission-profile-access-error";

import { UserRevokedAccessError } from "../errors/user-revoked-access-error";
import { UserDriverInactiveError } from "../errors/user-driver-inactive-error";
import { UserDeviceNotTrustedError } from "../errors/user-device-not-trusted-error";

import { parseSessionClient } from "../../services/session-service";

import { clientAddress } from "@/config/rate-limit";
import { accountFingerprint } from "@/shared/logging/account-fingerprint";

class AuthenticateUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email, cpf, password, businessId, deviceId } =
      sessionLoginSchema.parse(request.body);
    const authenticateUserUseCase = container.resolve(AuthenticateUserUseCase);

    // Picks the refresh policy of the caller's own new session: the app
    // idles for a week, the web for a day (see config/auth).
    const client = parseSessionClient(request.headers["x-trajetto-client"]);

    try {
      const {
        twoFactorVerificationMessage,
        isTwoFactorVerification,
        twoFactorChallenge,
        emailVerification,
        emailVerificationMessage,
        businessSelection,
        token,
        refresh_token,
        role,
        mustChangePassword,
      } =
        cpf !== undefined
          ? // Always the phone-bound session: no header picks its policy.
            await authenticateUserUseCase.executeByCpf({
              cpf,
              password,
              businessId,
              deviceId,
            })
          : await authenticateUserUseCase.execute(
              { email: email as string, password },
              client,
            );

      // The CPF matched in more than one company: the app asks which, and
      // sends the same body again with `businessId` (D8).
      if (businessSelection) {
        return reply.status(200).send({
          message: "Escolha a empresa para entrar.",
          businessSelection: true,
          businesses: businessSelection,
        });
      }

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
          // Additive: clients that know it send it back with the code and
          // with a resend; older ones ignore it.
          twoFactorChallenge,
        });
      }

      return reply.status(200).send({
        message: "Usuário autenticado com sucesso!",
        token,
        refresh_token,
        role,
        // Additive (wave 2): older clients ignore it.
        mustChangePassword: mustChangePassword ?? false,
      });
    } catch (error) {
      if (error instanceof UserDeviceNotTrustedError) {
        // The same trace as any failed login, the CPF only as a keyed
        // fingerprint (LGPD). No user id: nothing was compared, and which
        // logins the CPF has is exactly what this answer keeps to itself.
        request.log.warn(
          {
            event: "auth.login_failed",
            reason: "device_not_trusted",
            userId: null,
            account: accountFingerprint(cpf ?? ""),
            identifier: "cpf",
            withDevice: error.withDevice,
            clientAddress: clientAddress(request),
          },
          "Login failed",
        );

        return reply.status(403).send({
          code: error.code,
          message: error.message,
        });
      }

      if (error instanceof UserInvalidCredentialsError) {
        // The only trace of a failed login (OBS-13). The e-mail goes in as
        // a keyed fingerprint, never in clear; the address is the client's
        // as the rate limiter resolves it, not the reverse proxy's.
        request.log.warn(
          {
            event: "auth.login_failed",
            reason: error.reason ?? "invalid_credentials",
            userId: error.userId ?? null,
            // The CPF, like the e-mail, only as a keyed fingerprint (LGPD).
            account: accountFingerprint(cpf ?? email ?? ""),
            identifier: cpf !== undefined ? "cpf" : "email",
            clientAddress: clientAddress(request),
          },
          "Login failed",
        );

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

      throw error;
    }
  }
}

export { AuthenticateUserController };
