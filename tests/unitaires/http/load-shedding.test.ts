import fastify from "fastify";
import fastifyUnderPressure from "@fastify/under-pressure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import {
  createShedMetrics,
  handlePressure,
  loadSheddingOptions,
  pressureSignals,
  type ShedMode,
} from "@/shared/http/load-shedding";
import { shedClassOf } from "@/shared/http/shed-classes";

/**
 * What a pressed replica does with each request (plano-escala F2-24).
 *
 * `observe`, the default, must change no answer at all: it only counts what
 * `enforce` would refuse, and the owner reads seven days of those counts
 * before switching. In enforce the refusal is a 503 SERVICE_BUSY with
 * Retry-After, decided by the route's class and the whole reading — not by
 * the one threshold the plugin happens to report first. The GPS positions
 * are never refused here: an app build without back-off answers a 503 by
 * sending again at once, so they wait for the fleet's contract (F2-25).
 */

function requestFor(
  method: string,
  url: string,
  usage: { eventLoopUtilized: number; eventLoopDelay: number },
) {
  return {
    method,
    routeOptions: { url, config: { shedClass: shedClassOf(method, url) } },
    server: { memoryUsage: () => usage },
  } as never;
}

const CALM = { eventLoopUtilized: 0.4, eventLoopDelay: 10 };
const PRESSED = { eventLoopUtilized: 0.96, eventLoopDelay: 20 };
const DROWNING = { eventLoopUtilized: 0.99, eventLoopDelay: 20 };

function run(
  mode: ShedMode,
  method: string,
  url: string,
  usage: { eventLoopUtilized: number; eventLoopDelay: number },
) {
  const metrics = createShedMetrics({ mode: () => mode });
  const outcome = handlePressure(requestFor(method, url, usage), {} as never, {
    metrics,
    mode: () => mode,
  });

  return { outcome, metrics };
}

async function refusalOf(outcome: Promise<void> | undefined) {
  if (outcome === undefined) return null;

  try {
    await outcome;
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceBusyError);
    const busy = error as ServiceBusyError;

    return {
      status: busy.statusCode,
      code: busy.code,
      retryAfter: busy.retryAfterSeconds,
    };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("observe (the default)", () => {
  it("lets every request through and counts what enforce would refuse", async () => {
    const tower = run("observe", "GET", "/route/control-tower", DROWNING);
    const list = run("observe", "GET", "/delivery/list-delivery", DROWNING);

    expect(await refusalOf(tower.outcome)).toBeNull();
    expect(await refusalOf(list.outcome)).toBeNull();

    expect(tower.metrics.snapshot()).toMatchObject({
      mode: "observe",
      under_pressure: 1,
      reasons: { elu: 1 },
      would_shed: { tower: 1 },
      shed: {},
    });
    expect(list.metrics.snapshot().would_shed).toEqual({ lists: 1 });
  });
});

describe("enforce", () => {
  it("refuses a deferrable route at the first threshold, with 503 and 5 s", async () => {
    const { outcome, metrics } = run(
      "enforce",
      "GET",
      "/route/control-tower",
      PRESSED,
    );

    expect(await refusalOf(outcome)).toEqual({
      status: 503,
      code: "SERVICE_BUSY",
      retryAfter: 5,
    });
    expect(metrics.snapshot().shed).toEqual({ tower: 1 });
  });

  it("lets an interactive route through until the replica is drowning", async () => {
    expect(
      await refusalOf(
        run("enforce", "GET", "/delivery/list-delivery", PRESSED).outcome,
      ),
    ).toBeNull();

    expect(
      await refusalOf(
        run("enforce", "GET", "/delivery/list-delivery", DROWNING).outcome,
      ),
    ).toEqual({ status: 503, code: "SERVICE_BUSY", retryAfter: 5 });

    expect(
      await refusalOf(
        run("enforce", "GET", "/delivery/list-delivery", {
          eventLoopUtilized: 0.5,
          eventLoopDelay: 1_200,
        }).outcome,
      ),
    ).toEqual({ status: 503, code: "SERVICE_BUSY", retryAfter: 5 });
  });

  it("never refuses a critical route", async () => {
    for (const [method, url] of [
      ["POST", "/delivery/proof/:deliveryId/business/:businessId"],
      ["POST", "/user/refresh-token"],
      ["GET", "/health/readiness"],
    ]) {
      const { outcome, metrics } = run("enforce", method, url, DROWNING);

      expect(await refusalOf(outcome), url).toBeNull();
      expect(metrics.snapshot().would_shed, url).toEqual({});
    }
  });

  it("only counts the positions: they wait for the fleet's contract", async () => {
    const { outcome, metrics } = run(
      "enforce",
      "POST",
      "/route/positions",
      DROWNING,
    );

    expect(await refusalOf(outcome)).toBeNull();
    expect(metrics.snapshot().would_shed).toEqual({ positions: 1 });
  });

  it("refuses the deferrable routes when only the pool is saturated", async () => {
    vi.spyOn(pressureSignals, "poolSaturated").mockReturnValue(true);

    const tower = run("enforce", "GET", "/route/control-tower", CALM);
    const list = run("enforce", "GET", "/delivery/list-delivery", CALM);

    expect(await refusalOf(tower.outcome)).toMatchObject({ status: 503 });
    expect(await refusalOf(list.outcome)).toBeNull();
    expect(tower.metrics.snapshot().reasons).toEqual({ pool: 1 });
  });
});

describe("the counters", () => {
  it("start a fresh window when the ops_sample row reads them", () => {
    let clock = 0;
    const metrics = createShedMetrics({
      now: () => clock,
      mode: () => "observe",
    });

    metrics.recordPressure(["elu", "lag"]);
    metrics.recordWouldShed("tower");
    clock = 60_000;

    expect(metrics.rotate()).toEqual({
      window_seconds: 60,
      mode: "observe",
      under_pressure: 1,
      reasons: { elu: 1, lag: 1 },
      would_shed: { tower: 1 },
      shed: {},
    });
    expect(metrics.snapshot()).toMatchObject({
      window_seconds: 0,
      under_pressure: 0,
      would_shed: {},
    });
  });
});

describe("the pool signal", () => {
  afterEach(() => {
    pressureSignals.pool = null;
    pressureSignals.databaseUrl = undefined;
  });

  const pool = (waitingCount: number) => () => ({
    totalCount: 10,
    idleCount: 0,
    waitingCount,
    options: { max: 10 },
  });

  it("is saturated only with more requests waiting than the pool holds", () => {
    pressureSignals.pool = pool(10);
    expect(pressureSignals.poolSaturated()).toBe(false);

    pressureSignals.pool = pool(11);
    expect(pressureSignals.poolSaturated()).toBe(true);
  });

  it("says nothing when the pool cannot be read", () => {
    pressureSignals.pool = null;
    expect(pressureSignals.poolSaturated()).toBe(false);

    pressureSignals.pool = () => {
      throw new Error("no pool");
    };
    expect(pressureSignals.poolSaturated()).toBe(false);
  });
});

describe("the plugin's options", () => {
  it("register the lowest thresholds and the interval utilisation", () => {
    expect(loadSheddingOptions()).toMatchObject({
      maxEventLoopUtilization: 0.95,
      maxEventLoopDelay: 300,
      eventLoopUtilizationMode: "interval",
      healthCheckInterval: 1_000,
    });
  });

  // The real plugin, pressed through its health check: the handler's
  // rejection becomes the error the app's error handler answers.
  it("hand a refusal to the error handler and let the rest through", async () => {
    vi.spyOn(pressureSignals, "poolSaturated").mockReturnValue(true);

    const { env } = await import("@/env");
    const saved = env.SHED_MODE;
    env.SHED_MODE = "enforce";

    const app = fastify();

    app.addHook("onRoute", (route) => {
      route.config = {
        ...route.config,
        shedClass: shedClassOf(String(route.method), route.url),
      };
    });
    await app.register(fastifyUnderPressure, loadSheddingOptions());

    app.setErrorHandler((error, _request, reply) => {
      const busy = error as ServiceBusyError;

      return reply
        .status(busy.statusCode ?? 500)
        .header("retry-after", String(busy.retryAfterSeconds))
        .send({ code: busy.code });
    });

    app.get("/route/control-tower", async () => ({ ok: true }));
    app.get("/health/liveness", async () => ({ ok: true }));
    app.get("/delivery/list-delivery", async () => ({ ok: true }));

    try {
      await app.ready();

      // A calm loop, whatever the machine running the test is doing: only
      // the pool presses the replica here.
      vi.spyOn(
        app as unknown as { memoryUsage: () => unknown },
        "memoryUsage",
      ).mockReturnValue({
        eventLoopDelay: 0,
        eventLoopUtilized: 0,
        heapUsed: 0,
        rssBytes: 0,
      });

      const tower = await app.inject({ url: "/route/control-tower" });
      expect(tower.statusCode).toBe(503);
      expect(tower.headers["retry-after"]).toBe("5");
      expect(tower.json()).toEqual({ code: "SERVICE_BUSY" });

      expect((await app.inject({ url: "/health/liveness" })).statusCode).toBe(
        200,
      );
      expect(
        (await app.inject({ url: "/delivery/list-delivery" })).statusCode,
      ).toBe(200);
      expect((await app.inject({ url: "/no/such/route" })).statusCode).toBe(
        404,
      );
    } finally {
      env.SHED_MODE = saved;
      await app.close();
    }
  });
});
