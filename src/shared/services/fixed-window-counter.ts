import type { Redis } from "ioredis";

/**
 * One count in a fixed window: increment, and arm the window whenever the
 * key has none — in ONE script, so Redis runs both or neither.
 *
 * A fixed window rather than a sliding one, so the EXPIRE is only set when the
 * key has no TTL: re-arming on every attempt would push the window forward
 * and a steady stream would never reset.
 *
 * The obvious two-command version (INCR, then EXPIRE when the count is 1) is
 * how the socket handshake limiter used to do it, and whatever lost the
 * second command — a connection dropping with it in flight, ioredis replaying
 * an unanswered INCR after a reconnect (which then answers 2, so the branch is
 * skipped), a command timeout firing on a slow INCR — left a counter with no
 * TTL that no later attempt ever repaired: the subject was refused for good,
 * across Redis restarts (RDB keeps the key, noeviction never drops it).
 * Checking the TTL on every call, as @fastify/rate-limit's RedisStore does,
 * also heals any key already stuck that way on its next attempt.
 */
const COUNT_AND_ARM_WINDOW = [
  "local count = redis.call('INCR', KEYS[1])",
  "if redis.call('PTTL', KEYS[1]) == -1 then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  "end",
  "return count",
].join("\n");

/** The count after this call. Throws when Redis does: callers fail open. */
async function countInFixedWindow(
  redis: Pick<Redis, "eval">,
  key: string,
  windowSeconds: number,
): Promise<number> {
  return Number(await redis.eval(COUNT_AND_ARM_WINDOW, 1, key, windowSeconds));
}

export { COUNT_AND_ARM_WINDOW, countInFixedWindow };
