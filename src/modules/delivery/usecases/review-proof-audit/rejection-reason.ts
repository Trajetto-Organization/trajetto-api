const REJECTION_REASON_MIN = 5;
const REJECTION_REASON_MAX = 500;

/**
 * Two or more blanks inside a line. Line breaks are not blanks here: the
 * reason is typed in a multi-line box, and decision 5.5 keeps the
 * consecutive-spaces rule off the breaks of a multi-line text.
 */
const CONSECUTIVE_INLINE_BLANKS = /[^\S\r\n]{2,}/;

type RejectionReasonCheck =
  | { reason: string | null; problem: null }
  | { reason: string; problem: string };

/**
 * The reason a person gave for refusing a receipt, under the product's text
 * rules (DLVB-08).
 *
 * The edges are trimmed rather than refused, as the web already did; the
 * length is judged AFTER trimming, so "   abcd   " is four characters and not
 * the ten the schema counted. Consecutive blanks inside a line are refused
 * like in every other text field.
 */
function checkRejectionReason(
  raw: string | null | undefined,
): RejectionReasonCheck {
  const reason = raw?.trim() ?? "";

  if (!reason) return { reason: null, problem: null };

  if (reason.length < REJECTION_REASON_MIN) {
    return {
      reason,
      problem: `O motivo da rejeição deve ter no mínimo ${REJECTION_REASON_MIN} caracteres.`,
    };
  }

  if (reason.length > REJECTION_REASON_MAX) {
    return {
      reason,
      problem: `O motivo da rejeição deve ter no máximo ${REJECTION_REASON_MAX} caracteres.`,
    };
  }

  if (CONSECUTIVE_INLINE_BLANKS.test(reason)) {
    return {
      reason,
      problem: "O motivo da rejeição não deve conter espaços consecutivos.",
    };
  }

  return { reason, problem: null };
}

export { REJECTION_REASON_MAX, REJECTION_REASON_MIN, checkRejectionReason };
