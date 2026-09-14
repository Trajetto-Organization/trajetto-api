import { FastifyRequest } from "fastify";

import { UserRole } from "@/modules/user/dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";

interface TenantPrincipal {
  role: UserRole;
  businessId?: string | null;
}

function assertTenantAccess(
  principal: TenantPrincipal,
  requestedBusinessId: string,
): void {
  if (principal.role === "MASTER") return;

  if (!principal.businessId || principal.businessId !== requestedBusinessId) {
    throw new AppError(
      "Acesso negado aos dados desta empresa.",
      403,
      "TENANT_ACCESS_DENIED",
    );
  }
}

/**
 * Tenant check for a record reached by its OWN id, on a route that carries no
 * :businessId for the request hook to catch. User, profile and permission are
 * the three of those: the id in the path IS the sensitive resource, so the
 * only thing standing between two tenants is this comparison inside the use
 * case. A null businessId means the record belongs to no tenant (a MASTER
 * user), which only another MASTER may touch.
 */
function assertTenantAccessToRecord(
  principal: TenantPrincipal,
  recordBusinessId: string | null | undefined,
): void {
  if (!recordBusinessId) {
    if (principal.role !== "MASTER") {
      throw new AppError(
        "Acesso negado ao registro informado.",
        403,
        "TENANT_ACCESS_DENIED",
      );
    }

    return;
  }

  assertTenantAccess(principal, recordBusinessId);
}

function getRequestedTenantId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;

  const body = request.body as Record<string, unknown> | undefined;
  const candidate = params?.businessId ?? query?.businessId ?? body?.businessId;

  return typeof candidate === "string" ? candidate : undefined;
}

function authorizeRequestedTenant(request: FastifyRequest): void {
  const requestedBusinessId = getRequestedTenantId(request);

  if (requestedBusinessId) {
    assertTenantAccess(request.user, requestedBusinessId);
  }
}

/**
 * Fastify `preHandler` hook.
 *
 * `ensureAuthenticated` runs on `onRequest`, a stage where the body has not
 * been parsed yet — so a `businessId` sent in the body is invisible there and
 * escapes the check. This hook runs after parsing and closes that gap for
 * every route, including ones added later.
 */
async function enforceRequestedTenant(request: FastifyRequest): Promise<void> {
  // Public routes never populate `user`, so there is no tenant to enforce.
  if (!request.user) return;
  authorizeRequestedTenant(request);
}

export {
  TenantPrincipal,
  assertTenantAccess,
  assertTenantAccessToRecord,
  authorizeRequestedTenant,
  enforceRequestedTenant,
  getRequestedTenantId,
};
