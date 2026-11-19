import "fastify";

import type { BusinessModule } from "@prisma/client";
import type { ZodType } from "zod";

import { UserRole } from "@/modules/user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";
import type { AccessClaims } from "@/shared/auth/access-token-once";
import type { ShedClass } from "@/shared/http/shed-classes";

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
    /**
     * Whether a pressed replica may refuse the route (plano-escala F2-24).
     * Set for every route at registration (src/http.ts, onRoute) from
     * shared/http/shed-classes.ts; a route may declare its own.
     */
    shedClass?: ShedClass;
    /**
     * Units of the company's panel budget one request spends (plano-escala
     * F2-28, shared/integration/panel-budget.ts); absent, the route's group
     * decides.
     */
    panelCost?: number;
    /**
     * Whether ensureAuthenticated may answer from the session cache
     * (plano-escala F5-23, shared/auth/session-cache.ts, ADR 0015): only
     * the positions and the tower, and only while SESSION_CACHE_TTL_MS is
     * on. Absent everywhere else: the session is read on every request.
     */
    sessionCache?: boolean;
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
