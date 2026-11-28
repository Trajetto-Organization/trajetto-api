import type { core } from "zod";

/**
 * A field's own sentences for "missing" and "wrong", the zod 4 way.
 *
 * zod 3 took `required_error` and `invalid_type_error`; zod 4 dropped both
 * for one `error` callback, which also answers for the field's checks that
 * carry no message (a bare `.max(80)`). So this one answers only what the two
 * old options did: an absent value (`input` undefined) gets `required`, and
 * a present one of the wrong type gets `invalid` — `.int()` included, as in
 * zod 3, and an enum value off the list, which zod 4 reports with the same
 * code as a wrong type. Everything else, and a sentence left out, falls
 * through to the pt-BR defaults (zod-pt-br.ts); a check's own message wins.
 */
function fieldError(messages: { required?: string; invalid?: string }): {
  error: (issue: core.$ZodRawIssue) => string | undefined;
} {
  return {
    error: (issue) => {
      if (issue.input === undefined) return messages.required;

      return issue.code === "invalid_type" || issue.code === "invalid_value"
        ? messages.invalid
        : undefined;
    },
  };
}

export { fieldError };
