import { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@/shared/errors/AppError";

import { UserRole } from "../user/dtos/user-dto";

function verifyUserRole(allowedRoles: UserRole[]) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const { role } = request.user;

    if (!role || !allowedRoles.includes(role)) {
      done(new AppError("Usuário não autorizado!", 401));
      return;
    }

    done();
  };
}

export { verifyUserRole };
