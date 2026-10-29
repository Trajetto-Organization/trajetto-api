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
 * An optional multiline text field: empty reads as absent, and the value is
 * checked with the multiline rules above plus no blank text at all and no
 * whitespace (break included) at either end of the whole value.
 */
function optionalMultilineText(label: string, max: number) {
  return z.preprocess(
    (val) => (val === "" ? null : val),
    z
      .string()
      .max(max, `${label} deve ter no máximo ${max} caracteres.`)
      .superRefine((value, ctx) => {
        if (value.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não pode conter apenas espaços.`,
          });

          return;
        }

        if (hasInlineConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não deve conter espaços consecutivos.`,
          });

          return;
        }

        if (value !== value.trim() || hasSpaceAtLineEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não pode começar ou terminar com espaço em branco.`,
          });
        }
      })
      .nullable()
      .optional(),
  );
}

export {
  hasInlineConsecutiveSpaces,
  hasSpaceAtLineEdges,
  optionalMultilineText,
};
