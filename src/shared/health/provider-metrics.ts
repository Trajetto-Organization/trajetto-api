import os from "node:os";

/**
 * Latency and error rate of every call that leaves the process for a
 * provider, per channel (contract §32): e-mail (Resend), WhatsApp (Meta),
 * push (Expo, relaying to FCM), the AI OCR service and the customers'
 * webhooks.
 *
 * The delivery tables say what finally happened to a message; they cannot
 * say "Meta is answering in 8 s" or "a third of the OCR calls fail right
 * now" — a retry that eventually succeeds hides both. This is the in-process
 * view: the last WINDOW of calls per channel, per replica, like the runtime
 * numbers next to it on /health/metrics and on the minute log line that
 * carries every replica's copy to the log collector.
 *
 * Only a short error KIND is kept ("http_401", "timeout", "eauth"), never a
 * message: provider messages repeat addresses, phone numbers and, in the
 * worst case, the request that carried a credential.
 */

const PROVIDER_CHANNELS = ["EMAIL", "WHATSAPP", "PUSH", "AI_OCR", "WEBHOOK"] as const;

type ProviderChannel = (typeof PROVIDER_CHANNELS)[number];

interface ProviderSample {
  at: number;
  ms: number;
  ok: boolean;
  kind: string | null;
}

interface ProviderChannelMetrics {
  channel: ProviderChannel;

  /** Calls inside the window. */
  calls: number;
  errors: number;

  /** errors / calls, 0..1; null without a call in the window (unknown, not zero). */
  error_rate: number | null;

  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_max_ms: number | null;

  /** Since this replica started, whatever the window. */
  total_calls: number;
  total_errors: number;

  last_error_at: string | null;
  last_error_kind: string | null;
}

interface ProviderMetricsSnapshot {
  replica: string;
  window_minutes: number;
  channels: ProviderChannelMetrics[];
}

interface ProviderMetricsOptions {
  windowMs?: number;

  /** Samples kept per channel; older ones fall off even inside the window. */
  capacity?: number;
  now?: () => number;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;

  const rank = Math.ceil((p / 100) * sorted.length);

  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function createProviderMetrics({
  windowMs = 15 * 60 * 1000,
  capacity = 1000,
  now = Date.now,
}: ProviderMetricsOptions = {}) {
  const samples = new Map<ProviderChannel, ProviderSample[]>();
  const totals = new Map<ProviderChannel, { calls: number; errors: number }>();
  const lastError = new Map<ProviderChannel, { at: number; kind: string | null }>();

  function record(
    channel: ProviderChannel,
    ms: number,
    ok: boolean,
    kind: string | null = null,
  ): void {
    const at = now();
    const list = samples.get(channel) ?? [];

    list.push({ at, ms: Math.max(0, Math.round(ms)), ok, kind: ok ? null : kind });

    // A ring by trimming: a burst never grows memory past `capacity`.
    if (list.length > capacity) list.splice(0, list.length - capacity);

    samples.set(channel, list);

    const total = totals.get(channel) ?? { calls: 0, errors: 0 };
    total.calls += 1;
    if (!ok) total.errors += 1;
    totals.set(channel, total);

    if (!ok) lastError.set(channel, { at, kind });
  }

  function snapshot(): ProviderMetricsSnapshot {
    const since = now() - windowMs;

    return {
      replica: os.hostname(),
      window_minutes: Math.round(windowMs / 60_000),
      // Every channel, zero-filled: a dashboard never handles a missing key.
      channels: PROVIDER_CHANNELS.map((channel) => {
        const inWindow = (samples.get(channel) ?? []).filter((s) => s.at >= since);
        const latencies = inWindow.map((s) => s.ms).sort((a, b) => a - b);
        const errors = inWindow.filter((s) => !s.ok).length;
        const total = totals.get(channel) ?? { calls: 0, errors: 0 };
        const last = lastError.get(channel);

        return {
          channel,
          calls: inWindow.length,
          errors,
          error_rate: inWindow.length === 0 ? null : round(errors / inWindow.length),
          latency_p50_ms: percentile(latencies, 50),
          latency_p95_ms: percentile(latencies, 95),
          latency_max_ms: latencies.length ? latencies[latencies.length - 1] : null,
          total_calls: total.calls,
          total_errors: total.errors,
          last_error_at: last ? new Date(last.at).toISOString() : null,
          last_error_kind: last?.kind ?? null,
        };
      }),
    };
  }

  function reset(): void {
    samples.clear();
    totals.clear();
    lastError.clear();
  }

  return { record, snapshot, reset };
}

type ProviderMetrics = ReturnType<typeof createProviderMetrics>;

/**
 * A short, secret-free name for a failure. Reads only codes and statuses
 * that the transports put on their errors, never `message`.
 */
function providerErrorKind(error: unknown): string {
  if (!error || typeof error !== "object") return "error";

  const value = error as {
    name?: unknown;
    code?: unknown;
    responseCode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
    cause?: { code?: unknown };
  };

  if (value.name === "TimeoutError" || value.name === "AbortError") return "timeout";
  if (typeof value.httpStatus === "number") return `http_${value.httpStatus}`;
  if (typeof value.responseCode === "number") return `smtp_${value.responseCode}`;

  const code =
    typeof value.code === "string"
      ? value.code
      : typeof value.cause?.code === "string"
        ? value.cause.code
        : null;

  if (code && /^[A-Za-z0-9_]{2,40}$/.test(code)) return code.toLowerCase();
  if (typeof value.status === "number") return `http_${value.status}`;

  return "error";
}

/** The process-wide collector: /health/metrics and the minute log line read it. */
const providerMetrics = createProviderMetrics();

/**
 * Times one provider call and records its outcome. `outcome` decides for a
 * call that resolves with a failure (a fetch Response that is not ok); a
 * throw is always an error, re-thrown untouched.
 */
async function observeProviderCall<T>(
  channel: ProviderChannel,
  run: () => Promise<T>,
  outcome?: (value: T) => { ok: boolean; kind?: string | null },
  metrics: ProviderMetrics = providerMetrics,
): Promise<T> {
  const startedAt = performance.now();

  try {
    const value = await run();
    const verdict = outcome ? outcome(value) : { ok: true };

    metrics.record(channel, performance.now() - startedAt, verdict.ok, verdict.kind ?? null);

    return value;
  } catch (error) {
    metrics.record(channel, performance.now() - startedAt, false, providerErrorKind(error));

    throw error;
  }
}

/** For a fetch Response: ok, or the status as the kind. */
function httpOutcome(response: { ok: boolean; status: number }) {
  return { ok: response.ok, kind: response.ok ? null : `http_${response.status}` };
}

export {
  PROVIDER_CHANNELS,
  createProviderMetrics,
  httpOutcome,
  observeProviderCall,
  providerErrorKind,
  providerMetrics,
};
export type {
  ProviderChannel,
  ProviderChannelMetrics,
  ProviderMetrics,
  ProviderMetricsSnapshot,
};
