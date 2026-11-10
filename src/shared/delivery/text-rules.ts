import { z } from "zod";

/**
 * Free-text rules for MULTILINE fields (decision 5.5).
 *
 * The single-line rule (`hasConsecutiveSpaces` = /\s{2,}/) also matches line
 * breaks, so "Cliente ausente.\n\nVizinho informou" was refused — and from the
 * driver's offline queue a 400 is a permanent failure. Here a line break never
 * counts as a space: spaces and tabs may not repeat, and no LINE may start or
 * end with one. `\r` is treated as part of a break because a browser posts a
 * textarea with CRLF.
 *
 * Mirrored by trajetto-mobile/schemas/text-rules.ts and the web's
 * features/deliveries/lib/text-rules.ts.
 */
const INLINE_WHITESPACE_RUN = /[^\S\r\n]{2,}/;
const INLINE_WHITESPACE_AT_LINE_EDGE = /^[^\S\r\n]|[^\S\r\n]$/;

/** Two spaces or tabs in a row; line breaks excepted. */
function hasInlineConsecutiveSpaces(value: string): boolean {
  return INLINE_WHITESPACE_RUN.test(value);
}

/** A line that starts or ends with a space or a tab. */
function hasSpaceAtLineEdges(value: string): boolean {
  return value
    .split(/\r?\n/)
    .some((line) => INLINE_WHITESPACE_AT_LINE_EDGE.test(line));
}

/**
 * The first multiline rule the value breaks, as the sentence to show: no
 * blank text at all, the inline rules above, and no whitespace (break
 * included) at either end of the whole value. Null when it breaks none.
 */
function multilineTextIssue(label: string, value: string): string | null {
  if (value.trim().length === 0) {
    return `${label} não pode conter apenas espaços.`;
  }

  if (hasInlineConsecutiveSpaces(value)) {
    return `${label} não deve conter espaços consecutivos.`;
  }

  if (value !== value.trim() || hasSpaceAtLineEdges(value)) {
    return `${label} não pode começar ou terminar com espaço em branco.`;
  }

  return null;
}

/**
 * An optional multiline text field: empty reads as absent, and the value is
 * checked with the multiline rules above.
 */
function optionalMultilineText(label: string, max: number) {
  return z.preprocess(
    (val) => (val === "" ? null : val),
    z
      .string()
      .max(max, `${label} deve ter no máximo ${max} caracteres.`)
      .superRefine((value, ctx) => {
        const issue = multilineTextIssue(label, value);

        if (issue) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
        }
      })
      .nullable()
      .optional(),
  );
}

/**
 * The same rules on a field that must be there (the integration's cancel
 * reason, L9). `required` is said when it is missing or is not a text; the
 * bounds are zod checks, so the published JSON Schema carries them.
 */
function requiredMultilineText(
  label: string,
  bounds: { min: number; max: number; required: string },
) {
  return z
    .string({ message: bounds.required })
    .min(bounds.min, `${label} deve ter no mínimo ${bounds.min} caracteres.`)
    .max(bounds.max, `${label} deve ter no máximo ${bounds.max} caracteres.`)
    .superRefine((value, ctx) => {
      // Too short already said why; a blank under the minimum is that.
      if (value.length < bounds.min) return;

      const issue = multilineTextIssue(label, value);

      if (issue) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
      }
    });
}

export {
  hasInlineConsecutiveSpaces,
  hasSpaceAtLineEdges,
  optionalMultilineText,
  requiredMultilineText,
};
