import { compare, hash } from "bcrypt";

import { ServiceBusyError } from "@/shared/errors/service-busy-error";

/**
 * Every bcrypt hash and compare in the API goes through here.
 *
 * The native binding runs on libuv's threadpool, the same threads that serve
 * gzip for every response over 1 KB (@fastify/compress is global), `fs` and
 * `dns.lookup` for every provider and webhook call. A compare at cost 10 holds
 * a thread for ~55 ms, and nothing bounded how many could queue: under a
 * credential-stuffing run (per-address limits do not stop a botnet) the queue
 * grew without end, and measured with 80 operations queued a DNS lookup took
 * 553 ms, a 64 KB gzip 562 ms and a readFile 1.1 s — while the provider
 * timeouts were already running.
 *
 * So: at most MAX_CONCURRENT at a time per process, a short FIFO queue behind
 * them, and an immediate 503 beyond that. With UV_THREADPOOL_SIZE=8 (the
 * Dockerfile) bcrypt can hold two threads and never the other six. The queue
 * bounds the wait too: 50 × 55 ms / 2 ≈ 1.4 s at worst, well inside any
 * client timeout, and a refused caller is told when to come back instead of
 * piling on.
 *
 * Per process on purpose: the resource being protected is this process's
 * threadpool, and a shared counter (Redis) would be a network hop in front of
 * every login and one more thing to fail (ADR 0002).
 */

const DEFAULT_ROUNDS = 10;

const MAX_CONCURRENT = 2;
const MAX_QUEUED = 50;

const RETRY_AFTER_SECONDS = 2;

interface SecretGateOptions {
  maxConcurrent: number;
  maxQueued: number;
}

interface SecretGateStats {
  active: number;
  queued: number;
  max_concurrent: number;
  max_queued: number;
  refused_total: number;
}

function busy(): ServiceBusyError {
  return new ServiceBusyError(
    "Muitos acessos neste momento. Tente novamente em alguns segundos.",
    "AUTH_BUSY",
    RETRY_AFTER_SECONDS,
  );
}

function createSecretGate({ maxConcurrent, maxQueued }: SecretGateOptions) {
  let active = 0;
  let refusedTotal = 0;
  const waiting: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }

    if (waiting.length >= maxQueued) {
      refusedTotal += 1;
      return Promise.reject(busy());
    }

    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();

    // The slot passes straight to the oldest waiter, so `active` does not
    // change and nobody arriving in between can jump the queue.
    if (next) next();
    else active -= 1;
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    await acquire();

    try {
      return await work();
    } finally {
      release();
    }
  }

  return {
    hash: (plain: string, rounds: number = DEFAULT_ROUNDS) =>
      run(() => hash(plain, rounds)),

    compare: (plain: string, hashed: string) =>
      run(() => compare(plain, hashed)),

    stats: (): SecretGateStats => ({
      active,
      queued: waiting.length,
      max_concurrent: maxConcurrent,
      max_queued: maxQueued,
      refused_total: refusedTotal,
    }),
  };
}

const processGate = createSecretGate({
  maxConcurrent: MAX_CONCURRENT,
  maxQueued: MAX_QUEUED,
});

/** bcrypt.hash through the process gate. Rejects with ServiceBusyError when full. */
function hashSecret(plain: string, rounds: number = DEFAULT_ROUNDS) {
  return processGate.hash(plain, rounds);
}

/** bcrypt.compare through the process gate. Rejects with ServiceBusyError when full. */
function compareSecret(plain: string, hashed: string) {
  return processGate.compare(plain, hashed);
}

/** How loaded this replica's gate is, for /health/metrics. */
function gateStats(): SecretGateStats {
  return processGate.stats();
}

export {
  compareSecret,
  createSecretGate,
  gateStats,
  hashSecret,
  type SecretGateStats,
};
