/**
 * Valid-looking Brazilian documents for the simulated company: CPF and CNPJ
 * with correct check digits (the API checks both), built from a fixed base
 * so every run uses the same fictitious numbers. None belongs to anybody:
 * the bases start with 9s, a range no real registry assigns in sequence.
 */

function cpfCheckDigits(base9: string): string {
  const digits = base9.split("").map(Number);

  const first = (() => {
    const sum = digits.reduce(
      (total, digit, index) => total + digit * (10 - index),
      0,
    );
    const rest = (sum * 10) % 11;

    return rest === 10 ? 0 : rest;
  })();

  const second = (() => {
    const sum = [...digits, first].reduce(
      (total, digit, index) => total + digit * (11 - index),
      0,
    );
    const rest = (sum * 10) % 11;

    return rest === 10 ? 0 : rest;
  })();

  return `${first}${second}`;
}

/** The n-th simulated CPF (11 digits, valid check digits). */
function simulatedCpf(n: number): string {
  const base = `9${String(70_000_000 + n * 1_731).padStart(8, "0")}`;

  return `${base}${cpfCheckDigits(base)}`;
}

function cnpjCheckDigit(digits: number[]): number {
  const weights =
    digits.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = digits.reduce(
    (total, digit, index) => total + digit * weights[index],
    0,
  );
  const rest = sum % 11;

  return rest < 2 ? 0 : 11 - rest;
}

/** The n-th simulated CNPJ (14 digits, valid check digits, branch 0001). */
function simulatedCnpj(n: number): string {
  const base = `9${String(1_000_000 + n * 977).padStart(7, "0")}0001`;
  const digits = base.split("").map(Number);
  const first = cnpjCheckDigit(digits);
  const second = cnpjCheckDigit([...digits, first]);

  return `${base}${first}${second}`;
}

/** A Mercosul plate (AAA9A99) from a number. */
function simulatedPlate(n: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pick = (value: number) => letters[value % 26];

  return `SIM${n % 10}${pick(n * 7)}${String(10 + ((n * 37) % 90)).padStart(2, "0")}`;
}

/** An 11-digit RENAVAM-shaped number. */
function simulatedRenavam(n: number): string {
  return `9${String(100_000_000 + n * 7_919).padStart(10, "0")}`;
}

export { simulatedCnpj, simulatedCpf, simulatedPlate, simulatedRenavam };
