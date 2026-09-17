import { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@/shared/errors/AppError";

import { UserRole } from "../user/dtos/user-dto";

/**
 * The role gate, and the status it answers with.
 *
 * 403, not 401, and the difference is not pedantry. 401 means "I do not know
 * who you are"; 403 means "I know, and the answer is no". Both clients act on
 * that: the app treats any 401 as a session that is over and logs the driver
 * out, and the web's session check reads 401 as an expired session. So a
 * BUSINESS_ADMIN who opened a MASTER-only screen — or a driver who touched one
 * of the thirty-four routes behind this guard — was signed out of the product
 * instead of being told no.
 *
 * It also disagreed with the product's own convention: `verifyPermission`, the
 * gate right beside this one, has always answered 403 for exactly the same
 * kind of refusal.
 */
function verifyUserRole(allowedRoles: UserRole[]) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const { role } = request.user;

    if (!role || !allowedRoles.includes(role)) {
      done(
        new AppError(
          "Usuário não autorizado!",
          403,
          "AUTH_ROLE_FORBIDDEN",
        ),
      );

      return;
    }

    done();
  };
}

export { verifyUserRole };
