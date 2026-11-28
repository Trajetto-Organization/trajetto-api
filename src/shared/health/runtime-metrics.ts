import { promises as fs } from "node:fs";
import os from "node:os";
import {
  providerMetrics,
  type ProviderMetricsSnapshot,
} from "./provider-metrics";
import { httpMetrics } from "./http-metrics";
import { env } from "@/env";
import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from "node:perf_hooks";

/**
 * Saturation of this replica's runtime (GAP3-10): the numbers that say what
 * gives first inside the process, before anyone reaches for a bigger
 * database or a broker.
 *
 *  - event-loop lag (p50/p99/max): how late timers and I/O callbacks run. A
 *    synchronous parse or a CPU-bound burst shows here first;
 *  - event-loop utilisation: the share of the window the loop was busy. Near
 *    1 the replica is CPU-bound, whatever the database says;
 *  - threadpool canary: an fs.stat timed every few seconds. libuv's pool
 *    (UV_THREADPOOL_SIZE, 4 by default) is shared by bcrypt, zlib, DNS and fs,
 *    so a canary that takes hundreds of milliseconds is requests queueing for
 *    a thread;
 *  - memory: rss and heap in use;
 *  - CPU per request (plano-escala F4-01): the process's CPU in the window
 *    over the requests it finished outside /health. It is what the capacity
 *    proof divides the peak by; with the workers in the process their queue
 *    work is in it too, which `includes_workers` says.
 *
 * Per replica, like the Prisma pool next to it on /health/metrics: the
 * endpoint answers for the replica the sticky cookie picked, so every replica
 * also logs one line a minute (startRuntimeMetrics) for whatever collects the
 * logs. The alert thresholds (utilisation > 0.8 for 5 min, lag p99 > 200 ms,
 * canary > 250 ms, pool waiting > 0 for 1 min) belong to that collector.
 */

interface RuntimeSnapshot {
  replica: string;

  /** Seconds this snapshot covers: since start, or since the last rotate. */
  window_seconds: number;

  event_loop: {
    lag_p50_ms: number | null;
    lag_p99_ms: number | null;
    lag_max_ms: number | null;

    /** 0..1 share of the window the loop spent running JavaScript. */
    utilization: number;
  };

  threadpool: {
    size: number;
    canary_last_ms: number | null;
    canary_max_ms: number | null;
  };

  memory: {
    rss_mb: number;
    heap_used_mb: number;
  };

  cpu: {
    /** CPU this process spent in the window, in ms (process.cpuUsage). */
    user_ms: number;
    system_ms: number;

    /** Requests finished in the window, outside /health. */
    requests: number;

    /** (user + system) / requests; null without a request, never NaN. */
    ms_per_request: number | null;

    /** The workers run in this process (WORKERS_ENABLED): their work is in. */
    includes_workers: boolean;
  };
}

interface RuntimeMetrics {
  /** Interval of the log line startRuntimeMetrics writes. */
  readonly windowMs: number;

  start(): void;
  stop(): void;

  /** The current window, without resetting it. */
  snapshot(): RuntimeSnapshot;

  /** The current window, then a fresh one. */
  rotate(): RuntimeSnapshot;
}

const NS_PER_MS = 1e6;
const BYTES_PER_MB = 1024 * 1024;

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

interface CpuReading {
  /** Microseconds, as process.cpuUsage() reports them. */
  user: number;
  system: number;
}

function createRuntimeMetrics({
  windowMs = 60_000,
  canaryIntervalMs = 5_000,
  cpuUsage = () => process.cpuUsage(),
  requestsServed = () => httpMetrics.servedTotal(),
  includesWorkers = env.WORKERS_ENABLED,
  now = Date.now,
}: {
  windowMs?: number;
  canaryIntervalMs?: number;
  cpuUsage?: () => CpuReading;
  requestsServed?: () => number;
  includesWorkers?: boolean;
  now?: () => number;
} = {}): RuntimeMetrics {
  let histogram: IntervalHistogram | null = null;
  let eluMark: EventLoopUtilization = performance.eventLoopUtilization();
  let windowStartedAt = now();
  let cpuMark: CpuReading = cpuUsage();
  let requestsMark = requestsServed();

  let canaryTimer: NodeJS.Timeout | null = null;
  let canaryPending = false;
  let canaryLast: number | null = null;
  let canaryMax: number | null = null;

  function runCanary(): void {
    // One at a time: a canary still waiting for a thread IS the measurement,
    // and piling more on would only add to the queue it measures.
    if (canaryPending) return;
    canaryPending = true;

    const startedAt = performance.now();

    fs.stat(process.cwd())
      .catch(() => undefined)
      .finally(() => {
        const elapsed = round(performance.now() - startedAt, 2);

        canaryLast = elapsed;
        canaryMax = canaryMax === null ? elapsed : Math.max(canaryMax, elapsed);
        canaryPending = false;
      });
  }

  function cpuWindow(): RuntimeSnapshot["cpu"] {
    const reading = cpuUsage();

    // Never below zero: a counter that steps back (a reader replaced in a
    // test, a clock adjusted) reads as nothing spent, not as a negative cost.
    const userMs = Math.max(0, (reading.user - cpuMark.user) / 1000);
    const systemMs = Math.max(0, (reading.system - cpuMark.system) / 1000);
    const requests = Math.max(0, requestsServed() - requestsMark);
    const perRequest = requests > 0 ? (userMs + systemMs) / requests : null;

    return {
      user_ms: round(userMs),
      system_ms: round(systemMs),
      requests,
      ms_per_request:
        perRequest !== null && Number.isFinite(perRequest)
          ? round(perRequest, 3)
          : null,
      includes_workers: includesWorkers,
    };
  }

  function snapshot(): RuntimeSnapshot {
    const sampled = histogram !== null && histogram.count > 0;
    const loop = performance.eventLoopUtilization(eluMark);
    const memory = process.memoryUsage();

    return {
      replica: os.hostname(),
      window_seconds: round((now() - windowStartedAt) / 1000),
      event_loop: {
        lag_p50_ms: sampled
          ? round(histogram!.percentile(50) / NS_PER_MS, 2)
          : null,
        lag_p99_ms: sampled
          ? round(histogram!.percentile(99) / NS_PER_MS, 2)
          : null,
        lag_max_ms: sampled ? round(histogram!.max / NS_PER_MS, 2) : null,
        utilization: Number.isFinite(loop.utilization)
          ? round(loop.utilization, 3)
          : 0,
      },
      threadpool: {
        size: Number(process.env.UV_THREADPOOL_SIZE) || 4,
        canary_last_ms: canaryLast,
        canary_max_ms: canaryMax,
      },
      memory: {
        rss_mb: round(memory.rss / BYTES_PER_MB),
        heap_used_mb: round(memory.heapUsed / BYTES_PER_MB),
      },
      cpu: cpuWindow(),
    };
  }

  return {
    windowMs,

    start() {
      if (histogram) return;

      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();

      eluMark = performance.eventLoopUtilization();
      windowStartedAt = now();
      cpuMark = cpuUsage();
      requestsMark = requestsServed();

      canaryTimer = setInterval(runCanary, canaryIntervalMs);
      canaryTimer.unref();

      runCanary();
    },

    stop() {
      histogram?.disable();
      histogram = null;

      if (canaryTimer) clearInterval(canaryTimer);
      canaryTimer = null;
    },

    snapshot,

    rotate() {
      const current = snapshot();

      histogram?.reset();
      eluMark = performance.eventLoopUtilization();
      windowStartedAt = now();
      cpuMark = cpuUsage();
      requestsMark = requestsServed();
      canaryMax = canaryLast;

      return current;
    },
  };
}

/** The process-wide collector; /health/metrics reads it. */
const runtimeMetrics = createRuntimeMetrics();

interface LineLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

/** One finished window, as the per-minute sample (ops-sample.ts) takes it. */
interface RuntimeWindow {
  endedAt: Date;
  runtime: RuntimeSnapshot & { prisma_pool?: unknown };
  providers: ProviderMetricsSnapshot["channels"];
}

interface RuntimeMetricsOptions {
  /**
   * Called once per window, after the line, with the same numbers. It must
   * not throw (the sampler never does), and if it does the line still went
   * out and the next window still comes.
   */
  onWindow?: (window: RuntimeWindow) => void;
}

/**
 * Starts the collector and a log line per window with its numbers; returns
 * the function that stops both. Everything is unref'd: metrics never keep a
 * stopping process alive.
 *
 * `readPool` adds this replica's Prisma pool to the line as
 * `runtime.prisma_pool`, the same shape as on /health/metrics. The endpoint
 * shows one replica; this line is where every replica's pool — the ADR
 * 0001/0004 trigger — reaches the log collector. A pool that cannot be read
 * logs null, and the rest of the line still goes out.
 *
 * `options.onWindow` receives each window too, with the pool: it is how the
 * per-minute ops_sample row (plano-escala F1-08) is fed from the same
 * numbers as the line, in every process.
 */
function startRuntimeMetrics(
  log: LineLogger,
  metrics: RuntimeMetrics = runtimeMetrics,
  readPool?: () => Promise<unknown>,
  readProviders: () => ProviderMetricsSnapshot = () =>
    providerMetrics.snapshot(),
  options: RuntimeMetricsOptions = {},
): () => void {
  metrics.start();

  const timer = setInterval(() => {
    const endedAt = new Date();
    const runtime = metrics.rotate();

    // Provider latency and error rate (contract §32) ride on the same line,
    // only for the channels this replica called in the window: the endpoint
    // answers for one replica, the collector sums all of them.
    const providers = readProviders().channels.filter(
      (channel) => channel.calls > 0,
    );
    const extra = providers.length > 0 ? { providers } : {};

    const emit = (line: RuntimeWindow["runtime"]) => {
      log.info({ runtime: line, ...extra }, "runtime metrics");

      // A sampler bug must not cost the line, nor — from inside this timer —
      // the process.
      try {
        options.onWindow?.({ endedAt, runtime: line, providers });
      } catch {
        // The line above already carries the same numbers.
      }
    };

    if (!readPool) {
      emit(runtime);
      return;
    }

    // Through a promise even if the reader throws synchronously: a throw in a
    // timer callback would take the process down.
    void Promise.resolve()
      .then(readPool)
      .catch(() => null)
      .then((pool) => emit({ ...runtime, prisma_pool: pool }));
  }, metrics.windowMs);

  timer.unref();

  return () => {
    clearInterval(timer);
    metrics.stop();
  };
}

export { createRuntimeMetrics, runtimeMetrics, startRuntimeMetrics };
export type {
  RuntimeMetrics,
  RuntimeMetricsOptions,
  RuntimeSnapshot,
  RuntimeWindow,
};
