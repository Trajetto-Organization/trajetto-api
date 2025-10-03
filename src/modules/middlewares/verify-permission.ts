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
  driverId?: string;
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

    // Drivers (BUSINESS_USER with driverId) have specific permissions
    // They can read vehicles, branches, fuel types and write fuel/checklist
    if (user.role === "BUSINESS_USER" && user.driverId) {
      // Define driver permissions with their allowed access types
      const driverPermissions: Record<string, ("read" | "write")[]> = {
        vehicle_manage: ["read", "write"], // Read-only access to vehicles
        fuel_manage: ["read", "write"], // Full access to fuel records
      };

      const allowedAccessTypes = driverPermissions[permissionKey];

      // Check if driver has permission for this resource and access type
      if (allowedAccessTypes?.includes(accessType)) {
        return done(); // Permission granted
      }

      // Deny access for unauthorized resources
      return done(
        new AppError(
          "Motoristas não possuem permissão para acessar este recurso.",
          403,
        ),
      );
    }

    // For regular BUSINESS_USER, checks if profile and permission are set
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
