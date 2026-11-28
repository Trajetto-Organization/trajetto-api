import { z } from "zod";

import { passwordField } from "@/schemas/authenticate-user-schema";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * PATCH /user/:userId/driver-password (plan of 02/11/2026, D2): the new
 * password the manager sets for a driver's login, with the login's own rule.
 *
 * The tenant-locked field comes first: zod reports issues in shape order and
 * the 400's `message` is the first one, so a body that names a company is
 * refused for that, not for the missing password (decision 16.100).
 */
const resetDriverPasswordSchema = z.object({
  ...tenantLockedShape,
  password: passwordField.describe(
    "A nova senha do motorista (7 a 100 caracteres). Não é enviada por e-mail nem gravada em log ou atividade.",
  ),
});

export { resetDriverPasswordSchema };
