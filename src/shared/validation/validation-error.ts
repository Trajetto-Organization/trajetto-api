import { ZodRealError, type core, type ZodError } from "zod";

/**
 * A ZodError built by hand, as `.parse()` throws one.
 *
 * zod 4's `new ZodError(…)` is not an `Error`: no stack, and `instanceof
 * Error` is false. `.parse()` throws a ZodRealError, which is one. The error
 * handler answers either with 400 VALIDATION_ERROR, but a catch or a log line
 * that asks `instanceof Error` (zod 3's ZodError always was one) only knows
 * the second.
 */
function validationError(issues: core.$ZodIssue[]): ZodError {
  return new ZodRealError(issues);
}

export { validationError };
