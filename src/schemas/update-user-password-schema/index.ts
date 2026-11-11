import { z } from "zod";
import { storedPasswordField } from "@/schemas/authenticate-user-schema";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * A password a person sets for themselves: the change with the current one,
 * and the one created right after a QR code (wave 2). One rule for both.
 */
const ownPasswordField = z
  .string()
  .min(7, "A senha deve ter pelo menos 7 caracteres.")
  .max(100, "A senha deve ter no máximo 100 caracteres.")
  .refine((value) => !/\s/.test(value), {
    message: "A senha não deve conter espaços.",
  });

/**
 * The current password is checked by the login's rule, not the new one's: a
 * password the manager set (the initial one, a reset) may hold a space, and
 * the driver it flags with `must_change_password` must still be able to
 * prove it here — refused as malformed, the change could never happen.
 */
const updateUserPasswordSchema = z.object({
  ...tenantLockedShape,
  currentPassword: storedPasswordField,
  newPassword: ownPasswordField,
});

/**
 * POST /user/me/password (wave 2): the password the driver creates right
 * after entering by the manager's QR code, without a current one.
 */
const createOwnPasswordSchema = z.object({
  ...tenantLockedShape,
  password: ownPasswordField.describe(
    "A nova senha: de 7 a 100 caracteres, sem espaços.",
  ),
});

export { createOwnPasswordSchema, ownPasswordField, updateUserPasswordSchema };
