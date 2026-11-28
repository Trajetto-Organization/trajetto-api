/**
 * Brazilian E.164 normalization for the `to` field.
 *
 * The decision is made by LENGTH, never by a "55" prefix. Area code 55
 * (Santa Maria/RS) produces local numbers that already begin with "55", so a
 * prefix test reads them as already carrying the country code and ships a
 * truncated, wrong destination. Digit counts, in contrast, are unambiguous
 * inside Brazil:
 *
 *   10 digits — DDD + 8-digit landline        → prepend "55"
 *   11 digits — DDD + 9 + 8-digit mobile      → prepend "55"
 *   12 digits — 55 + DDD + 8-digit landline   → already complete
 *   13 digits — 55 + DDD + 9 + 8-digit mobile → already complete
 *
 * Any other length belongs to another country's numbering plan and is returned
 * exactly as typed — a country code is never invented for it. The known
 * limitation is that a foreign number that happens to be 10 or 11 digits long
 * is indistinguishable from a local Brazilian one; this product only sends to
 * Brazilian recipients, so length wins.
 *
 * Leading zeros are a dialling prefix, never part of the number, and are
 * dropped before the length is read: the trunk "0" of "011 99123-4567" and
 * the international "00" of "0055 11 …" that NF-e and ERP exports keep. No
 * country code and no Brazilian area code starts with 0; kept, the trunk
 * prefix went to Meta as 011991234567, a destination that does not exist.
 * The ninth digit of an old 8-digit mobile is NOT added here: the sender
 * writes the line as typed (only the opt-out key compares with it,
 * normalizeSuppressionPhone).
 *
 * Pure and free of the environment, so the customer opt-out (D38) keys a
 * phone by exactly the digits the Meta sender writes to.
 */
function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");

  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }

  return digits;
}

export { normalizePhoneNumber };
