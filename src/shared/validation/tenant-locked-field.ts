import { z } from "zod";

/**
 * A record belongs to the company it was created in, for good (decision
 * 16.100). No edit re-homes it: not a user, a driver, a vehicle, a part, a
 * profile or a permission.
 *
 * An explicit refusal instead of `.strict()` on every update body: the web
 * still sends UI-only fields (`userType`, ids of the form) that a strict
 * object would turn into 400s with no security value, while a `businessId`
 * in an edit body is always somebody trying to move the record — silently
 * stripping it (zod's default) answered 200 and hid that the move did not
 * happen.
 *
 * Validated by the route schema, so it runs before the tenant guard
 * (preHandler): MASTER and company users get the same 400 VALIDATION_ERROR.
 */
const TENANT_MOVE_REFUSED =
  "A empresa de um registro não muda pela edição. O registro pertence à empresa em que foi criado; para usá-lo em outra empresa, cadastre-o lá.";

const tenantLockedField = z
  .undefined({ errorMap: () => ({ message: TENANT_MOVE_REFUSED }) })
  .optional()
  .describe(
    "Não aceito: a empresa de um registro não muda pela edição (decisão 16.100). Enviado, com qualquer valor, responde 400 VALIDATION_ERROR.",
  );

/** Spread into every update body: `z.object({ ...tenantLockedShape, ... })`. */
const tenantLockedShape = { businessId: tenantLockedField };

export { TENANT_MOVE_REFUSED, tenantLockedField, tenantLockedShape };
