import { z } from "zod";

import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * PATCH /user/twofactor (wave 2): the state wanted, and the current password.
 *
 * Explicit, so a retried request after a timeout lands on the same state
 * instead of undoing it, and with the password, so a session somebody else
 * holds cannot switch the second factor off. A request with no body at all
 * keeps the old blind toggle for one release (the web image serving during
 * the rollout sends none); the controller parses by hand for that reason.
 */
const updateTwoFactorSchema = z.object({
  ...tenantLockedShape,
  enabled: z
    .boolean({
      required_error: "Informe se a verificação fica ligada ou desligada.",
      invalid_type_error: "Informe se a verificação fica ligada ou desligada.",
    })
    .describe(
      "true liga, false desliga. O estado atual responde 200 sem mudar nada.",
    ),
  password: z
    .string({ required_error: "Informe a senha atual." })
    .min(1, "Informe a senha atual.")
    .max(100, "A senha deve ter no máximo 100 caracteres.")
    .describe("A senha atual da conta."),
});

export { updateTwoFactorSchema };
