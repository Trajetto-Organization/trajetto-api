import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderMetrics } from "@/shared/health/provider-metrics";
import {
  createRuntimeMetrics,
  startRuntimeMetrics,
} from "@/shared/health/runtime-metrics";

/**
 * Provider latency and error rate reach the log collector from EVERY replica
 * (contract §32): /health/metrics answers for the one replica the sticky
 * cookie picked, so the minute line is where a slow Meta seen by replica B
 * shows up when the screen is reading replica A.
 */
interface Line {
  fields: Record<string, unknown>;
  message: string;
}

afterEach(() => {
  vi.useRealTimers();
});

function run(providers: ReturnType<typeof createProviderMetrics>) {
  const lines: Line[] = [];
  const log = {
    info(fields: Record<string, unknown>, message: string) {
      lines.push({ fields, message });
    },
  };

  const metrics = createRuntimeMetrics({ windowMs: 1_000, canaryIntervalMs: 60_000 });
  const stop = startRuntimeMetrics(log, metrics, async () => ({ limit: 5 }), () =>
    providers.snapshot(),
  );

  return { lines, stop };
}

describe("the minute runtime line", () => {
  it("carries the providers this replica called, with latency and error rate", async () => {
    vi.useFakeTimers();

    const providers = createProviderMetrics();
    providers.record("WHATSAPP", 800, false, "http_500");
    providers.record("WHATSAPP", 400, true);

    const { lines, stop } = run(providers);

    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      stop();
    }

    const logged = lines[0].fields.providers as Array<Record<string, unknown>>;

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      channel: "WHATSAPP",
      calls: 2,
      errors: 1,
      error_rate: 0.5,
      latency_max_ms: 800,
    });
  });

  it("stays as it was when no provider was called", async () => {
    vi.useFakeTimers();

    const { lines, stop } = run(createProviderMetrics());

    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      stop();
    }

    expect(lines[0].fields).not.toHaveProperty("providers");
    expect(lines[0].fields).toHaveProperty("runtime");
  });
});
