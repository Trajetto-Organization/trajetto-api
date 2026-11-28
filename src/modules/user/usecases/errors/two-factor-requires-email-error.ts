import { AppError } from "@/shared/errors/AppError";

/**
 * The second factor's code travels by e-mail: an account without one would
 * turn on a check that never asks anything (the CPF login skips it, the
 * e-mail login does not exist for it). Refused instead of stored (wave 2).
 */
class TwoFactorRequiresEmailError extends AppError {
  constructor() {
    super(
      "Para ligar a verificação em duas etapas, cadastre um e-mail na sua conta.",
      409,
      "TWO_FACTOR_REQUIRES_EMAIL",
    );
  }
}

export { TwoFactorRequiresEmailError };
