import "fastify";

import { UserRole } from "@/modules/user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";

interface Permission {
  permissionKey: string;
  canRead: boolean;
  canWrite: boolean;
}

interface ProfileAccess {
  name: string;
  permissions: Permission[];
}

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      role: UserRole;
      profileAccess?: ProfileAccess | null;
      driverId?: string | null;
      driver?: {
        id: string;
        branchId: string | null;
      } | null;
    };
  }
}
