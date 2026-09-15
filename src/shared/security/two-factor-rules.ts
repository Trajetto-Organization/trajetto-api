/**
 * How many guesses a two-factor code survives.
 *
 * Five. The code is `randomInt(100_000, 1_000_000)` — six digits, a million
 * possibilities — and it lives for fifteen minutes. With no ceiling a wrong
 * guess consumed nothing and counted towards nothing, and the only barrier was
 * the anonymous-route rate limit, which was walkable around through a header
 * the client writes. A million possibilities with unlimited attempts is a code
 * that gets guessed.
 *
 * Five leaves plenty of room for a typo; for somebody guessing, the search
 * space stops being a million and becomes five per code. Asking for a new code
 * deletes the previous one, so restarting the count costs an e-mail — which
 * the account's owner can see.
 */
const MAX_TWO_FACTOR_ATTEMPTS = 5;

export { MAX_TWO_FACTOR_ATTEMPTS };
