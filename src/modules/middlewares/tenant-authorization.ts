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
 *
 * The refusal is the caller's own "not found", not a 403: a 403 for another
 * company's id next to a 404 for an unknown one told any tenant which ids
 * exist elsewhere (found by the IDOR sweep, 10/2026). Ids leak through
 * exports, screenshots and support tickets; knowing one must not confirm it.
 */
function assertTenantAccessToRecord(
  principal: TenantPrincipal,
  recordBusinessId: string | null | undefined,
  notFound: () => AppError,
): void {
  if (principal.role === "MASTER") return;

  if (!recordBusinessId || principal.businessId !== recordBusinessId) {
    throw notFound();
  }
}

/**
 * The refusal for a record of another company reached through a path whose
 * :businessId the tenant guard already matched to the caller. For a tenant
 * user that can only mean "someone else's row", which must look exactly like
 * a missing one. A MASTER may see every company, so for them the specific
 * mismatch stays: it tells an operator the path names the wrong company.
 */
function foreignRecordRefusal(
  principal: Pick<TenantPrincipal, "role">,
  mismatch: () => AppError,
  notFound: () => AppError,
): AppError {
  return principal.role === "MASTER" ? mismatch() : notFound();
}

/**
 * Every tenant the request names, from every place it can name one.
 *
 * ALL of them, never the first one found. Picking a single candidate
 * (`params ?? query ?? body`) let the caller choose which location the guard
 * read: `?businessId=<own>` on a POST whose body carried another company's id
 * passed the check, and the use case — which reads the body — acted on the
 * other company. `?businessId=` (an empty string) and a repeated
 * `?businessId=a&businessId=b` (an array) skipped the check outright, because
 * neither was a non-empty string.
 *
 * A null or absent value names no tenant. Anything else present — empty
 * string, array element, number, object — is returned as-is so the caller can
 * refuse it.
 */
function requestedTenantValues(request: FastifyRequest): unknown[] {
  const sources = [request.params, request.query, request.body];
  const values: unknown[] = [];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const value = (source as Record<string, unknown>).businessId;
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }

  return values;
}

/**
 * The tenant a request names, when it names exactly one well-formed tenant.
 * Kept for callers that need the id itself; authorization goes through
 * `authorizeRequestedTenant`, which inspects every value.
 */
function getRequestedTenantId(request: FastifyRequest): string | undefined {
  const values = requestedTenantValues(request);
  const [first] = values;

  const unambiguous =
    typeof first === "string" &&
    first.length > 0 &&
    values.every((value) => value === first);

  return unambiguous ? first : undefined;
}

function authorizeRequestedTenant(request: FastifyRequest): void {
  if (request.user.role === "MASTER") return;

  for (const value of requestedTenantValues(request)) {
    // A malformed tenant reference is refused like a foreign one: the use
    // case behind it may read the same field differently than this guard.
    if (typeof value !== "string" || value.length === 0) {
      throw new AppError(
        "Acesso negado aos dados desta empresa.",
        403,
        "TENANT_ACCESS_DENIED",
      );
    }

    assertTenantAccess(request.user, value);
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
  foreignRecordRefusal,
  enforceRequestedTenant,
  getRequestedTenantId,
  requestedTenantValues,
};
