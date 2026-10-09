import "fastify";

import type { BusinessModule } from "@prisma/client";
import type { ZodTypeAny } from "zod";

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
  /**
   * Documentation-only extras, read by routes/documentation/openapi-transform.
   *
   * Nothing here validates anything. `body` and `headers` describe what a
   * controller parses by hand (after normalising form fields, or copying a
   * header into the body), where a real `schema.body` would change what the
   * route accepts. `module` is set by `requireModuleForPlugin`.
   */
  interface FastifyContextConfig {
    openapi?: {
      body?: ZodTypeAny;
      headers?: ZodTypeAny;
      module?: BusinessModule;
    };
  }

  interface FastifyRequest {
    user: {
      id: string;
      role: UserRole;
      businessId: string | null;
      sessionVersion: number;
      sessionId: string;
      profileAccess?: ProfileAccess | null;
      driverId?: string | null;
      driver?: {
        id: string;
        branchId: string | null;
      } | null;
      /**
       * The modules the user's own company hired, as the session lookup of
       * THIS request loaded them. Lets the module gate answer without reading
       * them again; absent (e.g. API-key requests) means "ask the database".
       */
      entitlements?: Array<{ module: string; enabled: boolean }> | null;
    };
  }
}
