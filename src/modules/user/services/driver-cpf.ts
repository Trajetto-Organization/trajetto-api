/**
 * The CPF a driver types to sign in (plan of 02/11/2026, D8; decision D02).
 *
 * Pure. The login accepts the CPF with or without its mask, as the phone's
 * numeric keyboard and a copy from a document give it, and refuses anything
 * whose check digits do not match before a single row is read: a typo is the
 * driver's mistake to fix on the screen, not a guess to count against the
 * account. Drivers are stored with the 11 digits only (create-driver-schema),
 * so the normalized value is what the lookup compares.
 */

const CPF_LENGTH = 11;

function checkDigit(digits: string, length: number): number {
  let sum = 0;

  for (let index = 0; index < length; index += 1) {
    sum += Number(digits[index]) * (length + 1 - index);
  }

  const rest = (sum * 10) % 11;

  return rest === 10 ? 0 : rest;
}

/** True for 11 digits whose two check digits match. Repeated digits fail. */
function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;

  // "00000000000" and friends pass the arithmetic and are never real.
  if (/^(\d)\1{10}$/.test(digits)) return false;

  return (
    checkDigit(digits, 9) === Number(digits[9]) &&
    checkDigit(digits, 10) === Number(digits[10])
  );
}

/**
 * The CPF as stored (11 digits), or null when it is not a valid CPF. Dots,
 * dashes and spaces are dropped; any other character makes it invalid, so a
 * value with letters is never "fixed" into somebody else's CPF.
 */
function normalizeCpf(value: string): string | null {
  if (!/^[\d.\-\s]+$/.test(value)) return null;

  const digits = value.replace(/\D/g, "");

  return digits.length === CPF_LENGTH && isValidCpf(digits) ? digits : null;
}

export { isValidCpf, normalizeCpf };
