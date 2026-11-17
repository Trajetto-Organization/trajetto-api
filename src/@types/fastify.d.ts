import "fastify";

import type { BusinessModule } from "@prisma/client";
import type { ZodType } from "zod";

import { UserRole } from "@/modules/user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";
import type { AccessClaims } from "@/shared/auth/access-token-once";

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
      body?: ZodType;
      headers?: ZodType;
      module?: BusinessModule;
    };
  }

  interface FastifyRequest {
    /**
     * Who the access token names, from its signature alone, set by the first
     * check of this request (shared/auth/access-token-once.ts). The session is
     * not validated yet when the limiter reads it: never authorize by it.
     */
    accessClaims?: AccessClaims;
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
