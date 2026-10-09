import { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";

import { UserRole } from "../user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";

type AccessType = "read" | "write";

interface Permission {
  permissionKey: string;
  canRead: boolean;
  canWrite: boolean;
}

interface PermissionPrincipal {
  role: UserRole;
  profileAccess?: { permissions: Permission[] } | null;
  driverId?: string | null;
}

interface VerifyPermissionOptions {
  /**
   * `false` refuses driver tokens even where the driver map below grants the
   * key. For company-wide reads the driver's own screens never call (decision
   * 4.4): the map works per key, and a key such as `vehicle_manage:read`
   * covers both "the vehicle I drive" and "the whole fleet".
   */
  allowDriver?: boolean;
}

/**
 * What a driver token may do, per key.
 *
 * Drivers carry no profile access, so this table stands in for one. The app
 * lists the day (read) and appoints — start route, arrival, proof (write);
 * dispatcher-only operations (create, edit, assign, import) refuse driver
 * tokens inside their use cases.
 */
const DRIVER_PERMISSIONS: Readonly<
  Partial<Record<PermissionKey, readonly AccessType[]>>
> = {
  vehicle_manage: ["read"],
  vehicle_checklist_manage: ["read", "write"],
  service_order_manage: ["read"],
  fuel_manage: ["read", "write"],
  delivery_manage: ["read", "write"],
  // Typed reports from the field; reading the company's catalogue is not
  // the driver's (the app reads the types through its own delivery routes).
  occurrence_manage: ["write"],
};

/**
 * The verdict, apart from Fastify so the whole role × key × access matrix
 * can be proven without a server.
 *
 * Every refusal is a 403 PERMISSION_DENIED (decision 4.1). The missing-profile
 * branch used to answer 401, which both clients read as "your session ended"
 * and log the user out; it is a configuration problem, answered with the same
 * code the session check uses for it.
 */
function decidePermission(
  principal: PermissionPrincipal,
  permissionKey: PermissionKey,
  accessType: AccessType,
  options: VerifyPermissionOptions = {},
): AppError | null {
  // Admins hold every permission of their own company by definition; the
  // tenant and module guards still apply to them.
  if (principal.role === "MASTER" || principal.role === "BUSINESS_ADMIN") {
    return null;
  }

  if (principal.role === "BUSINESS_USER" && principal.driverId) {
    const allowed =
      options.allowDriver !== false &&
      Boolean(DRIVER_PERMISSIONS[permissionKey]?.includes(accessType));

    return allowed
      ? null
      : permissionDenied(
          "Motoristas não possuem permissão para acessar este recurso.",
        );
  }

  if (!principal.profileAccess) {
    return new AppError(
      "Perfil de acesso não associado ao usuário.",
      403,
      "AUTH_PROFILE_NOT_CONFIGURED",
    );
  }

  const permission = principal.profileAccess.permissions.find(
    (perm) => perm.permissionKey === permissionKey,
  );

  if (!permission) {
    return permissionDenied(
      "Seu perfil de acesso não inclui esta seção. Peça ao administrador da empresa para liberar o acesso.",
    );
  }

  // Unreadable is no access at all, writes included: the web hides the
  // section of such a row (readablePermissionKeys), and a write the screen
  // can never offer must not be open to a direct call either.
  if (!permission.canRead) {
    return permissionDenied(
      "Seu perfil de acesso não permite visualizar esta seção.",
    );
  }

  if (accessType === "write" && !permission.canWrite) {
    return permissionDenied(
      "Seu perfil de acesso permite apenas a leitura desta seção.",
    );
  }

  return null;
}

function verifyPermission(
  permissionKey: PermissionKey,
  accessType: AccessType,
  options: VerifyPermissionOptions = {},
) {
  const hook = (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const refusal = decidePermission(
      request.user as PermissionPrincipal,
      permissionKey,
      accessType,
      options,
    );

    done(refusal ?? undefined);
  };

  // Read back by the OpenAPI transform, which only sees the hook itself: the
  // closure hides which permission it checks, and the document would
  // otherwise leave every client guessing which profile a route needs.
  return Object.assign(hook, {
    openapi: { permission: { key: permissionKey, access: accessType } },
  });
}

interface PermissionAlternative {
  key: PermissionKey;
  access: AccessType;
  options?: VerifyPermissionOptions;
}

/**
 * Either of several grants (decision 4.7): the pickers and the service-order
 * reads let a dispatcher (`delivery_manage:write`) in beside the catalogue's
 * own key. The first alternative that passes wins; when none does, the
 * refusal is the FIRST alternative's — the route's primary key, the one the
 * profile screen should offer.
 */
function decideAnyPermission(
  principal: PermissionPrincipal,
  alternatives: readonly PermissionAlternative[],
): { granted: PermissionAlternative } | { refusal: AppError } {
  let firstRefusal: AppError | null = null;

  for (const alternative of alternatives) {
    const refusal = decidePermission(
      principal,
      alternative.key,
      alternative.access,
      alternative.options,
    );

    if (!refusal) return { granted: alternative };

    firstRefusal ??= refusal;
  }

  // An empty list grants nothing: deny by default.
  return {
    refusal:
      firstRefusal ??
      permissionDenied("Seu perfil de acesso não inclui esta seção."),
  };
}

/**
 * What a guard with alternatives attaches for the OpenAPI transform, which
 * reads a list of `permission`s as "all of". A hook that decides more than
 * pass/refuse (a picker choosing its projection) attaches it too.
 */
function anyPermissionDoc(alternatives: readonly PermissionAlternative[]): {
  openapi: { anyOf: Array<{ key: PermissionKey; access: AccessType }> };
} {
  return {
    openapi: {
      anyOf: alternatives.map(({ key, access }) => ({ key, access })),
    },
  };
}

function verifyAnyPermission(alternatives: readonly PermissionAlternative[]) {
  // A route registered with no alternative is a wiring mistake, caught at
  // boot rather than as a route nobody can call.
  if (alternatives.length === 0) {
    throw new Error("verifyAnyPermission needs at least one alternative");
  }

  const hook = (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    const verdict = decideAnyPermission(
      request.user as PermissionPrincipal,
      alternatives,
    );

    done("refusal" in verdict ? verdict.refusal : undefined);
  };

  return Object.assign(hook, anyPermissionDoc(alternatives));
}

export {
  anyPermissionDoc,
  decideAnyPermission,
  decidePermission,
  verifyAnyPermission,
  verifyPermission,
  DRIVER_PERMISSIONS,
};
export type {
  PermissionAlternative,
  PermissionPrincipal,
  VerifyPermissionOptions,
};
