/**
 * The per-account brake on password guessing.
 *
 * The login's only bound used to be the route rate limit: eight attempts a
 * minute per address, counted in Redis. That counter fails open on purpose
 * (ADR 0002) — with Redis down or slow every login went through unlimited,
 * and only the cost of bcrypt stood between an attacker and a known address.
 * It is also keyed by address, so a guess spread over many addresses never
 * met it at all.
 *
 * This one lives on the user row in Postgres, so it holds with or without
 * Redis and whatever the number of addresses:
 *
 * - failures are counted while they keep coming less than a window apart; a
 *   quiet window starts the count over, so the odd typo never adds up;
 * - reaching the ceiling locks the account for a while, and while locked the
 *   login is refused even with the right password;
 * - once the lock runs out the count is NOT reset: the next wrong password
 *   locks again straight away. After the first ten, a guesser gets one try
 *   per lock period — about four an hour — instead of hundreds a second;
 * - a successful login, or a new password (reset or change), clears it all.
 *
 * The refusal while locked is the same "e-mail ou senha inválidos" as a wrong
 * password, never a message of its own: a distinct answer after ten failures
 * would tell whoever sent them that the address has an account. The owner
 * who is locked out gets out through "esqueci minha senha", which clears the
 * lock.
 *
 * Pure: the repository applies it atomically in SQL, and the in-memory
 * repository applies these same functions.
 */

/** Wrong passwords in a row, less than a window apart, before the lock. */
const MAX_FAILED_LOGINS = 10;

/** A failure older than this no longer counts towards the lock. */
const FAILED_LOGIN_WINDOW_MS = 60 * 60 * 1000;

/** How long a lock lasts. Long enough to ruin guessing, short enough to wait. */
const LOGIN_LOCK_MS = 15 * 60 * 1000;

interface LoginLockoutState {
  failed_login_attempts?: number | null;
  failed_login_at?: Date | null;
  login_locked_until?: Date | null;
}

function isLoginLocked(state: LoginLockoutState, now: Date): boolean {
  return Boolean(
    state.login_locked_until &&
      state.login_locked_until.getTime() > now.getTime(),
  );
}

/** Failures stamped before this instant start the count over. */
function failureWindowStart(now: Date): Date {
  return new Date(now.getTime() - FAILED_LOGIN_WINDOW_MS);
}

function lockUntil(now: Date): Date {
  return new Date(now.getTime() + LOGIN_LOCK_MS);
}

/**
 * The row after one more wrong password — what the repository's single
 * UPDATE computes from the row it locks.
 */
function afterFailedLogin(
  state: LoginLockoutState,
  now: Date,
): Required<LoginLockoutState> {
  const stale =
    !state.failed_login_at ||
    state.failed_login_at.getTime() < failureWindowStart(now).getTime();

  const attempts = stale ? 1 : (state.failed_login_attempts ?? 0) + 1;

  return {
    failed_login_attempts: attempts,
    failed_login_at: now,
    login_locked_until:
      attempts >= MAX_FAILED_LOGINS
        ? lockUntil(now)
        : (state.login_locked_until ?? null),
  };
}

export {
  FAILED_LOGIN_WINDOW_MS,
  LOGIN_LOCK_MS,
  MAX_FAILED_LOGINS,
  afterFailedLogin,
  failureWindowStart,
  isLoginLocked,
  lockUntil,
  type LoginLockoutState,
};
