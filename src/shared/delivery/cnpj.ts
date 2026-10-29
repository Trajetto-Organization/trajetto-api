/**
 * CNPJ check digits (decision 5.7).
 *
 * The shipper's CNPJ is now unique per company and the NF-e import matches the
 * issuer by it, so a typo is not harmless any more: it either blocks the real
 * issuer's CNPJ or makes the import create a second shipper. The two check
 * digits catch almost every typo. Mirrored by the web's
 * features/deliveries/lib/cnpj.ts.
 */
const FIRST_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(digits: string, weights: number[]): number {
  const sum = weights.reduce(
    (total, weight, index) => total + Number(digits[index]) * weight,
    0,
  );

  const rest = sum % 11;

  return rest < 2 ? 0 : 11 - rest;
}

/** True for 14 digits whose check digits match. Repeated digits are refused. */
function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value)) return false;

  // "00000000000000" and friends pass the arithmetic and are never real.
  if (/^(\d)\1{13}$/.test(value)) return false;

  const first = checkDigit(value, FIRST_WEIGHTS);
  const second = checkDigit(value, SECOND_WEIGHTS);

  return first === Number(value[12]) && second === Number(value[13]);
}

export { isValidCnpj };
