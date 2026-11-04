import { randomBytes, randomInt } from "node:crypto";

/**
 * The driver's access QR code and its short code (plan of 02/11/2026, D3;
 * decision D01). Pure, apart from the random draws.
 *
 * The manager shows the QR code (or reads out the code) and the driver's
 * phone opens a session with it, once, within ten minutes. Both are
 * credentials while they live, so they are drawn from the OS's CSPRNG and
 * only their hashes are stored (DriverEnrollmentRepository).
 */

/** How long a QR code opens a session: long enough to read it, no longer. */
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/**
 * Refused presentations (the driver inactive, the access revoked…) before
 * the code is spent for good. A guess of an unknown code has no row to count
 * against: those are braked by the route limit.
 */
const ENROLLMENT_MAX_ATTEMPTS = 5;

/**
 * The short code's alphabet: no I, O, 0 or 1, which a person reading it out
 * or typing it confuses. 32 symbols, 8 of them: 40 bits, against a guesser
 * held to the route limit and a ten-minute life.
 *
 * Public by design: the app ships the same alphabet to check a typed code,
 * and it only says which characters a code may hold. gitleaks' generic rule
 * takes a long string given to a name with "access" in it for a key, so the
 * literal's line carries gitleaks' inline allow comment, which moves with
 * the line.
 */
const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // gitleaks:allow
const ACCESS_CODE_LENGTH = 8;

/**
 * What the QR code encodes: a fixed prefix, a version, the environment and
 * the opaque token — never a password. The app refuses a code of another
 * environment (a staging build reads only staging codes), and the version
 * leaves room to change the format without misreading old screens.
 */
const QR_CONTENT_PREFIX = "trajetto-enroll";
const QR_CONTENT_VERSION = "1";

/** 256 bits, URL-safe, so it travels in the QR code and in JSON as is. */
function generateQrToken(): string {
  return randomBytes(32).toString("base64url");
}

function generateAccessCode(): string {
  let code = "";

  for (let index = 0; index < ACCESS_CODE_LENGTH; index += 1) {
    code += ACCESS_CODE_ALPHABET[randomInt(ACCESS_CODE_ALPHABET.length)];
  }

  return code;
}

/**
 * The code as typed — any case, with the hyphen of its display or spaces —
 * as stored, or null when it cannot be one. Lookups take only this form.
 */
function normalizeAccessCode(value: string): string | null {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();

  if (compact.length !== ACCESS_CODE_LENGTH) return null;

  for (const symbol of compact) {
    if (!ACCESS_CODE_ALPHABET.includes(symbol)) return null;
  }

  return compact;
}

/** "ABCD-EFGH": how the screen shows it, easier to read out. */
function formatAccessCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function enrollmentQrContent(token: string, environment: string): string {
  return [QR_CONTENT_PREFIX, QR_CONTENT_VERSION, environment, token].join(":");
}

export {
  ACCESS_CODE_ALPHABET,
  ACCESS_CODE_LENGTH,
  ENROLLMENT_MAX_ATTEMPTS,
  ENROLLMENT_TTL_MS,
  QR_CONTENT_PREFIX,
  enrollmentQrContent,
  formatAccessCode,
  generateAccessCode,
  generateQrToken,
  normalizeAccessCode,
};
