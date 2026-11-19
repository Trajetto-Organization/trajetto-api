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

/**
 * The same window, spending `cost` units at once (the panel budget,
 * plano-escala F2-28: a tower read costs more than a detail). Returns the
 * total after this call and the window's remaining time, so a refusal can
 * say exactly when to come back.
 */
const SPEND_AND_ARM_WINDOW = [
  "local count = redis.call('INCRBY', KEYS[1], ARGV[2])",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if ttl == -1 then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  "  ttl = tonumber(ARGV[1]) * 1000",
  "end",
  "return { count, ttl }",
].join("\n");

/** Throws when Redis does: callers fail open. */
async function spendInFixedWindow(
  redis: Pick<Redis, "eval">,
  key: string,
  windowSeconds: number,
  cost: number,
): Promise<{ total: number; resetInMs: number }> {
  const [total, ttl] = (await redis.eval(
    SPEND_AND_ARM_WINDOW,
    1,
    key,
    windowSeconds,
    cost,
  )) as [number, number];

  return {
    total: Number(total),
    resetInMs: Number(ttl) > 0 ? Number(ttl) : windowSeconds * 1000,
  };
}

/**
 * The same windows, spending `cost` units on EVERY key only when each one
 * still fits it (`count + cost <= its max`), all in one script: either all
 * spend or none does. The public API's batch (plano-escala U-04) spends N
 * units of the key's minute and of the company's; spending first and
 * checking after kept the units of a refused batch, and a key whose minute
 * could not take the batch was locked out of its single calls until the
 * minute turned.
 *
 * KEYS are the windows, ARGV[1] the window in seconds, ARGV[2] the cost
 * and ARGV[3..] each key's max. Returns the 1-based index of the first
 * key that did not fit (0 when all spent), then each key's count (after
 * the spend, or as it stands when refused) and its remaining ms.
 */
const SPEND_WITHIN_WINDOWS = [
  "local cost = tonumber(ARGV[2])",
  "local counts = {}",
  "local refused = 0",
  "for i = 1, #KEYS do",
  "  counts[i] = tonumber(redis.call('GET', KEYS[i]) or '0') or 0",
  "  if refused == 0 and counts[i] + cost > tonumber(ARGV[2 + i]) then",
  "    refused = i",
  "  end",
  "end",
  "local out = { refused }",
  "for i = 1, #KEYS do",
  "  if refused == 0 then",
  "    counts[i] = redis.call('INCRBY', KEYS[i], cost)",
  "  end",
  "  local ttl = redis.call('PTTL', KEYS[i])",
  "  if refused == 0 and ttl == -1 then",
  "    redis.call('EXPIRE', KEYS[i], ARGV[1])",
  "    ttl = tonumber(ARGV[1]) * 1000",
  "  end",
  "  out[#out + 1] = counts[i]",
  "  out[#out + 1] = ttl",
  "end",
  "return out",
].join("\n");

interface WindowSpend {
  /** The count after the spend, or as it stands when the call was refused. */
  total: number;
  resetInMs: number;
}

/** Throws when Redis does: callers fail open. */
async function spendWithinFixedWindows(
  redis: Pick<Redis, "eval">,
  windows: ReadonlyArray<{ key: string; max: number }>,
  windowSeconds: number,
  cost: number,
): Promise<{ refusedIndex: number | null; windows: WindowSpend[] }> {
  const reply = (await redis.eval(
    SPEND_WITHIN_WINDOWS,
    windows.length,
    ...windows.map((window) => window.key),
    windowSeconds,
    cost,
    ...windows.map((window) => window.max),
  )) as number[];

  const refused = Number(reply[0]);

  return {
    refusedIndex: refused > 0 ? refused - 1 : null,
    windows: windows.map((_, index) => {
      const ttl = Number(reply[2 + index * 2]);

      return {
        total: Number(reply[1 + index * 2]),
        resetInMs: ttl > 0 ? ttl : windowSeconds * 1000,
      };
    }),
  };
}

export {
  COUNT_AND_ARM_WINDOW,
  SPEND_AND_ARM_WINDOW,
  SPEND_WITHIN_WINDOWS,
  countInFixedWindow,
  spendInFixedWindow,
  spendWithinFixedWindows,
};
export type { WindowSpend };
