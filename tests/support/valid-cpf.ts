/**
 * A CPF the API accepts, built from any 9-digit base: the base and its two
 * check digits, the arithmetic of src/modules/user/services/driver-cpf.ts.
 * The one generator of the tests: the ones that register or edit a driver
 * through the schema, which refuses a wrong check digit
 * (src/schemas/driver-cpf-field), and the ones that seed a driver who signs
 * in by CPF, which the login refuses the same way. A counter or random digits
 * make a base, never a whole CPF. A base of one repeated digit gives a
 * repeated CPF, which the API refuses; callers keep their bases mixed.
 */
function checkDigit(digits: string, length: number): number {
  let sum = 0;

  for (let index = 0; index < length; index += 1) {
    sum += Number(digits[index]) * (length + 1 - index);
  }

  const rest = (sum * 10) % 11;

  return rest === 10 ? 0 : rest;
}

function validCpf(base: string): string {
  if (!/^\d{9}$/.test(base)) {
    throw new Error(`validCpf: a base de 9 dígitos é obrigatória (${base}).`);
  }

  const first = checkDigit(base, 9);

  return `${base}${first}${checkDigit(`${base}${first}`, 10)}`;
}

export { validCpf };
