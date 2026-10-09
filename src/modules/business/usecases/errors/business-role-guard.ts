import { UserRole } from "@/modules/user/dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";

/**
 * The route's role gate, repeated inside the use case.
 *
 * The company routes are MASTER-only (the AI usage and the plan also admit the
 * company's own admin), but the use cases trusted the route alone: a missing
 * or regressed `verifyUserRole` let a BUSINESS_ADMIN create, rename or delete
 * companies, or raise their own limits. Same message and code as the route
 * gate, so the answer does not depend on which wall caught it.
 */
function assertCallerRole(
  user: { role: UserRole },
  allowedRoles: readonly UserRole[],
): void {
  if (allowedRoles.includes(user.role)) return;

  throw new AppError("Usuário não autorizado!", 403, "AUTH_ROLE_FORBIDDEN");
}

export { assertCallerRole };
