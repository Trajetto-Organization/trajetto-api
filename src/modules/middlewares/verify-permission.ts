import { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@/shared/errors/AppError";

import { UserRole } from "../user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";

interface Permission {
  permissionKey: PermissionKey;
  canRead: boolean;
  canWrite: boolean;
}

interface ProfileAccess {
  permissions: Permission[];
}

interface AuthenticatedUser {
  id: string;
  role: UserRole;
  profileAccess?: ProfileAccess;
}

function verifyPermission(
  permissionKey: PermissionKey,
  accessType: "read" | "write",
) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const user = request.user as AuthenticatedUser;

    // MASTER and BUSINESS_ADMIN users have unrestricted access
    if (user.role === "MASTER" || user.role === "BUSINESS_ADMIN") {
      return done();
    }

    // For BUSINESS_USER, checks if profile and permission are set
    if (!user.profileAccess) {
      return done(
        new AppError("Perfil de acesso não associado ao usuário.", 401),
      );
    }

    const permission = user.profileAccess.permissions.find(
      (perm) => perm.permissionKey === permissionKey,
    );

    if (!permission) {
      return done(
        new AppError(
          "Permissão não encontrada! Usuário não possui permissão para visualizar este conteúdo.",
          403,
        ),
      );
    }

    if (accessType === "write" && !permission.canWrite) {
      return done(
        new AppError(
          "Usuário não possui permissão para executar esta ação.",
          403,
        ),
      );
    }

    if (accessType === "read" && !permission.canRead) {
      return done(
        new AppError(
          "Usuário não possui permissão para visualizar este conteúdo.",
          403,
        ),
      );
    }

    done();
  };
}

export { verifyPermission };
