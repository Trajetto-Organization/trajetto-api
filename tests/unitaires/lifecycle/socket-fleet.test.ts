import { spawnSync } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HANDSHAKES_PER_ADDRESS,
  HANDSHAKES_PER_USER,
  SOCKET_MAX_CONNECTIONS_PER_USER,
} from "@/shared/socket/handshake-rate-limit";

/**
 * The socket fleet (tests/load/socket-fleet.mjs, plano-escala LOAD-05).
 *
 * A fleet from one address, or one that reconnects every socket of a
 * restart at once, measures the API's handshake budgets (300 per address
 * and 30 per user a minute, 20 sockets per user on a replica), not the
 * fleet: so every handshake goes through a pacer that keeps each origin
 * and each token below them, and the plan refuses what cannot fit. The
 * run through the edge crosses the Traefik and the conntrack production
 * uses: so it has its own caps (20 handshakes/s, 10 minutes, the load
 * window, 1,000 sockets on the single VPS and 5,000 on the second) and the
 * burn-in's probes. The fleet itself runs here for real, against a
 * Socket.IO server on the loopback, with eight origins bound to eight
 * loopback addresses.
 */
const SCRIPT = resolve(process.cwd(), "tests", "load", "socket-fleet.mjs");

type Fleet = {
  API_HANDSHAKES_PER_ADDRESS: number;
  API_HANDSHAKES_PER_USER: number;
  API_SOCKETS_PER_USER: number;
  planFleet: (env: Record<string, string>, options?: object) => any;
  runFleet: (plan: any, deps: object) => Promise<any>;
  createPacer: (options: object) => any;
  createProbes: (env: Record<string, string>, deps: object) => any;
  cpuPressure: (before: string, after: string) => any;
  maxPerMinute: (attempts: Array<{ origin: string; atMs: number }>) => number;
  mergeSummaries: (summaries: any[]) => any;
  originKey: (address: string | null) => string;
  readinessLimit: (base: number, floor?: number) => number;
  refusalOf: (error: unknown) => string;
  summarize: (raw: object) => any;
};

const load = () => import(pathToFileURL(SCRIPT).href) as Promise<Fleet>;

const loadClient = async () =>
  (
    (await import(
      pathToFileURL(
        resolve(process.cwd(), "tests", "load", "lib", "socket-client.mjs"),
      ).href
    )) as { loadSocketClient: () => Promise<unknown> }
  ).loadSocketClient();

const tokens = (count: number) =>
  Array.from({ length: count }, (_, i) => `token-${i}`);

const EIGHT = Array.from({ length: 8 }, (_, i) => `127.0.0.${i + 2}`).join(",");

// Tuesday 17 November 2026, 06:10 UTC: inside the load window.
const IN_WINDOW = Date.UTC(2026, 10, 17, 6, 10);

const edge = (env: Record<string, string> = {}) => ({
  FLEET_URL: "https://api-staging.intrajetto.com",
  ...env,
});

describe("the budgets are the API's (LOAD-05)", () => {
  it("never reaches the handshake budgets of handshake-rate-limit.ts", async () => {
    const fleet = await load();

    expect(fleet.API_HANDSHAKES_PER_ADDRESS).toBe(HANDSHAKES_PER_ADDRESS);
    expect(fleet.API_HANDSHAKES_PER_USER).toBe(HANDSHAKES_PER_USER);
    expect(fleet.API_SOCKETS_PER_USER).toBe(SOCKET_MAX_CONNECTIONS_PER_USER);

    const plan = fleet.planFleet(
      { FLEET_SOURCE_ADDRESSES: EIGHT },
      { tokens: tokens(200) },
    );

    expect(plan.perOrigin).toBeLessThan(HANDSHAKES_PER_ADDRESS);
    expect(plan.perToken).toBeLessThan(HANDSHAKES_PER_USER);
    expect(plan.socketsPerToken).toBeLessThan(SOCKET_MAX_CONNECTIONS_PER_USER);
  });

  it("refuses a per-origin or per-token budget at the API's own", async () => {
    const { planFleet } = await load();
    const base = { FLEET_SOURCE_ADDRESSES: EIGHT };

    expect(() =>
      planFleet(
        { ...base, FLEET_ORIGIN_PER_MINUTE: "300" },
        { tokens: tokens(200) },
      ),
    ).toThrow(/FLEET_ORIGIN_PER_MINUTE=300: vai de 1 a 299/);
    expect(() =>
      planFleet(
        { ...base, FLEET_TOKEN_PER_MINUTE: "30" },
        { tokens: tokens(200) },
      ),
    ).toThrow(/FLEET_TOKEN_PER_MINUTE=30/);
    expect(() =>
      planFleet(
        { ...base, FLEET_SOCKETS_PER_TOKEN: "21" },
        { tokens: tokens(200) },
      ),
    ).toThrow(/FLEET_SOCKETS_PER_TOKEN=21/);
  });

  it("keys IPv6 origins by their /64, as the API does", async () => {
    const { originKey } = await load();

    expect(originKey("2001:db8:1:2::10")).toBe(originKey("2001:db8:1:2::99"));
    expect(originKey("2001:db8:1:3::10")).not.toBe(
      originKey("2001:db8:1:2::10"),
    );
    expect(originKey("192.0.2.10")).toBe("192.0.2.10");
  });
});

describe("the plan (LOAD-05)", () => {
  it("asks for eight origins in direct mode", async () => {
    const { planFleet } = await load();

    expect(() => planFleet({}, { tokens: tokens(200) })).toThrow(
      /1 origem\(ns\) para FLEET_MIN_ORIGINS=8/,
    );

    const plan = planFleet(
      { FLEET_SOURCE_ADDRESSES: EIGHT },
      { tokens: tokens(200) },
    );

    expect(plan.origins).toBe(8);
    // Eight origins at 240 a minute: 32 handshakes a second at most.
    expect(plan.rate).toBe(32);
  });

  it("counts the origins of the other shards", async () => {
    const { planFleet } = await load();

    const plan = planFleet({ FLEET_SHARD: "3/8" }, { tokens: tokens(200) });

    expect(plan.shardSockets).toBe(125);
    expect(plan.tokens).toEqual(tokens(200).filter((_, i) => i % 8 === 2));
  });

  it("refuses more sockets per token than asked, naming the tokens it needs", async () => {
    const { planFleet } = await load();

    expect(() =>
      planFleet({ FLEET_SOURCE_ADDRESSES: EIGHT }, { tokens: tokens(51) }),
    ).toThrow(/são precisos 100 tokens/);
  });

  it("refuses a ramp faster than the budgets allow", async () => {
    const { planFleet } = await load();

    expect(() =>
      planFleet(
        { FLEET_SOURCE_ADDRESSES: EIGHT, FLEET_RATE: "40" },
        { tokens: tokens(200) },
      ),
    ).toThrow(/deixam no máximo 32\.0 handshakes\/s/);
  });

  it("refuses a restart whose sockets could not all be back in a minute", async () => {
    const { planFleet } = await load();
    const env = {
      FLEET_SOURCE_ADDRESSES: "127.0.0.2,127.0.0.3,127.0.0.4,127.0.0.5",
      FLEET_MIN_ORIGINS: "4",
      FLEET_RESTART_AFTER_S: "30",
      FLEET_DURATION: "10m",
    };

    // 1,000 sockets over 4 origins at 240 a minute: 250 each.
    expect(() => planFleet(env, { tokens: tokens(200) })).toThrow(
      /A volta em ≤ 60 s de 1000 sockets pede 5 origens/,
    );
    expect(
      planFleet(
        { ...env, FLEET_SOURCE_ADDRESSES: EIGHT, FLEET_MIN_ORIGINS: "8" },
        { tokens: tokens(200) },
      ).restartAtMs,
    ).not.toBeNull();
  });

  it("refuses a restart the hold leaves no minute to come back from", async () => {
    const { planFleet } = await load();

    expect(() =>
      planFleet(
        {
          FLEET_SOURCE_ADDRESSES: EIGHT,
          FLEET_RESTART_AFTER_S: "60",
          FLEET_DURATION: "3m",
        },
        { tokens: tokens(200) },
      ),
    ).toThrow(/pedem 240 s de espera/);
  });

  it.each(["api.intrajetto.com", "WWW.intrajetto.com", "intrajetto.com"])(
    "refuses the production host %s in either mode",
    async (host) => {
      const { planFleet } = await load();

      expect(() =>
        planFleet({ FLEET_URL: `https://${host}` }, { tokens: tokens(200) }),
      ).toThrow(/é a produção/);
      expect(() =>
        planFleet(
          { FLEET_URL: `https://${host}` },
          { argv: ["--via-edge"], tokens: tokens(200), nowMs: IN_WINDOW },
        ),
      ).toThrow(/é a produção/);
    },
  );

  it("sends staging through the edge, never directly", async () => {
    const { planFleet } = await load();

    expect(() =>
      planFleet(
        { FLEET_URL: "https://api-staging.intrajetto.com" },
        { tokens: tokens(200) },
      ),
    ).toThrow(/é a staging: rode com --via-edge/);
  });
});

describe("the edge's own caps (LOAD-05)", () => {
  const viaEdge = async (env: Record<string, string>, nowMs = IN_WINDOW) => {
    const { planFleet } = await load();

    return () =>
      planFleet(edge(env), {
        argv: ["--via-edge"],
        tokens: tokens(1_000),
        nowMs,
      });
  };

  it("refuses 1,001 sockets on the single VPS and accepts 1,000", async () => {
    expect(await viaEdge({ FLEET_SOCKETS: "1001" })).toThrow(
      /na VPS única o teto é 1000 sockets/,
    );

    const plan = (await viaEdge({ FLEET_SOCKETS: "1000" }))();

    expect(plan.sockets).toBe(1_000);
    expect(plan.topology).toBe("single-vps");
    // One origin (the host) at 240 a minute.
    expect(plan.rate).toBe(4);
  });

  it("takes 5,000 only on the second VPS", async () => {
    const env = {
      FLEET_SOCKETS: "5000",
      FLEET_EDGE_TOPOLOGY: "second-vps",
      FLEET_SOURCE_ADDRESSES: Array.from(
        { length: 5 },
        (_, i) => `192.0.2.${i + 10}`,
      ).join(","),
    };

    expect(await viaEdge({ ...env, FLEET_SOCKETS: "5001" })).toThrow(
      /no 2º VPS o teto é 5000 sockets/,
    );
    expect((await viaEdge(env))().sockets).toBe(5_000);
    expect(await viaEdge({ ...env, FLEET_EDGE_TOPOLOGY: "" })).toThrow(
      /5\.000 só depois do G-03/,
    );
  });

  it("ramps at 20 handshakes a second at most, for 10 minutes at most", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `192.0.2.${i + 10}`).join(
      ",",
    );

    expect(
      (await viaEdge({ FLEET_SOURCE_ADDRESSES: many, FLEET_SOCKETS: "1000" }))()
        .rate,
    ).toBe(20);
    expect(
      await viaEdge({ FLEET_SOURCE_ADDRESSES: many, FLEET_RATE: "21" }),
    ).toThrow(/FLEET_RATE=21: vai de 1 a 20/);
    expect(await viaEdge({ FLEET_DURATION: "11m" })).toThrow(
      /pela borda o teto é 10 minutos/,
    );
  });

  it.each([
    [Date.UTC(2026, 10, 15, 6, 10), "Domingo"],
    [Date.UTC(2026, 11, 1, 6, 10), "dia 1"],
    [Date.UTC(2026, 10, 17, 5, 59), "Fora da janela"],
    [Date.UTC(2026, 10, 17, 7, 50), "Fora da janela"],
  ])("refuses outside the load window (%s)", async (nowMs, reason) => {
    expect(await viaEdge({}, nowMs)).toThrow(new RegExp(reason));
  });

  it("asks for a staging host, by name, over https", async () => {
    expect(await viaEdge({ FLEET_URL: "https://api.example.com" })).toThrow(
      /não é um host de staging/,
    );
    expect(
      await viaEdge({ FLEET_URL: "http://api-staging.intrajetto.com" }),
    ).toThrow(/só https/);
  });
});

describe("the pacer (LOAD-05)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never lets an origin or a token pass its budget in any 60 s", async () => {
    vi.useFakeTimers();

    const { createPacer, maxPerMinute } = await load();
    const pacer = createPacer({
      perOrigin: 3,
      perToken: 2,
      now: () => Date.now(),
    });
    const granted: Array<{ origin: string; token: number; atMs: number }> = [];

    for (let i = 0; i < 9; i += 1) {
      const entry = { origin: "a", token: i % 3, notBefore: 0 };

      pacer
        .acquire(entry)
        .then(() => granted.push({ ...entry, atMs: Date.now() }));
    }

    await vi.advanceTimersByTimeAsync(200_000);

    expect(granted).toHaveLength(9);
    expect(maxPerMinute(granted)).toBe(3);

    for (const token of [0, 1, 2]) {
      expect(
        maxPerMinute(
          granted
            .filter((grant) => grant.token === token)
            .map((grant) => ({ origin: "t", atMs: grant.atMs })),
        ),
      ).toBeLessThanOrEqual(2);
    }

    pacer.stop();
  });

  it("holds a slot until its time", async () => {
    vi.useFakeTimers();

    const { createPacer } = await load();
    const pacer = createPacer({ perOrigin: 10, perToken: 10, now: Date.now });
    let grantedAt = 0;
    const start = Date.now();

    pacer
      .acquire({ origin: "a", token: 0, notBefore: start + 5_000 })
      .then(() => {
        grantedAt = Date.now();
      });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(grantedAt - start).toBe(5_000);
  });
});

describe("the refusals (LOAD-05)", () => {
  it("retries what the admission refuses, never a bad credential", async () => {
    const { refusalOf } = await load();

    expect(
      refusalOf({ data: { code: "SOCKET_UNAVAILABLE", retryAfterMs: 6_000 } }),
    ).toBe("unavailable");
    expect(refusalOf({ data: { code: "SOCKET_RATE_LIMITED" } })).toBe(
      "rateLimited",
    );
    expect(
      refusalOf({ type: "TransportError", message: "websocket error" }),
    ).toBe("transport");
    expect(refusalOf({ message: "timeout" })).toBe("transport");
    expect(refusalOf({ message: "Token inválido" })).toBe("credential");
    expect(refusalOf({ data: { code: "SESSION_REVOKED" } })).toBe("credential");
  });
});

describe("the probes, the burn-in's (LOAD-05)", () => {
  /** A /proc/stat with this much CPU time in each counter. */
  const stat = (counters: {
    user?: number;
    idle?: number;
    iowait?: number;
    steal?: number;
  }) =>
    `cpu  ${counters.user ?? 0} 0 0 ${counters.idle ?? 0} ${counters.iowait ?? 0} 0 0 ${counters.steal ?? 0} 0 0
cpu0 1 2 3 4 5 6 7 8 9 10
intr 1
`;

  const probesWith = async (
    answers: Array<{ status: number; ms: number }>,
    stats: string[] = [stat({ idle: 100 })],
  ) => {
    const { createProbes } = await load();
    let i = 0;
    let j = 0;

    return createProbes(
      {},
      {
        sample: async () => answers[Math.min(i++, answers.length - 1)],
        readStat: () => stats[Math.min(j++, stats.length - 1)],
        sleep: async () => undefined,
      },
    );
  };

  it("refuses to start when production's readiness already fails", async () => {
    const answers = [
      ...Array.from({ length: 11 }, () => ({ status: 200, ms: 5 })),
      { status: 503, ms: 5 },
    ];
    const probes = await probesWith(answers);

    await expect(probes.base()).rejects.toThrow(/já falha antes da carga/);
  });

  it("aborts at twice the base, never under the 20 ms floor", async () => {
    const { readinessLimit } = await load();

    expect(readinessLimit(4)).toBe(20);
    expect(readinessLimit(15)).toBe(30);

    const answers = [
      ...Array.from({ length: 12 }, () => ({ status: 200, ms: 15 })),
      { status: 200, ms: 45 },
    ];
    const probes = await probesWith(answers);

    expect(await probes.base()).toEqual({ p95: 15, limit: 30 });

    let reason = null;

    for (let i = 0; i < 4 && !reason; i += 1) reason = await probes.check();

    expect(reason).toContain("p95 45 ms (teto 30 ms)");
  });

  it("aborts on three failures", async () => {
    const answers = [
      ...Array.from({ length: 12 }, () => ({ status: 200, ms: 5 })),
      { status: 0, ms: 5_000 },
    ];
    const probes = await probesWith(answers);

    await probes.base();

    expect(await probes.check()).toBeNull();
    expect(await probes.check()).toBeNull();
    expect(await probes.check()).toMatch(/falhou 3 vezes/);
  });

  it("reads iowait and steal as vmstat does: between two readings, not since boot", async () => {
    const { cpuPressure } = await load();

    // Since boot the host idled; in the last interval 35% went to iowait.
    expect(
      cpuPressure(
        stat({ user: 1_000, idle: 9_000 }),
        stat({ user: 1_030, idle: 9_035, iowait: 35 }),
      ),
    ).toEqual({ iowait: 35, steal: 0 });
    expect(
      cpuPressure(
        stat({ idle: 100 }),
        stat({ user: 40, idle: 148, steal: 12 }),
      ),
    ).toEqual({ iowait: 0, steal: 12 });
    expect(cpuPressure("", stat({ idle: 1 }))).toBeNull();
    expect(cpuPressure(stat({ idle: 5 }), stat({ idle: 5 }))).toBeNull();
  });

  it.each([
    [{ user: 1_045, idle: 9_020, iowait: 35 }, /iowait do host em 35%/],
    [{ user: 1_038, idle: 9_050, steal: 12 }, /steal do host em 12%/],
  ])("aborts when the host passes its ceiling (%o)", async (after, reason) => {
    const answers = Array.from({ length: 13 }, () => ({ status: 200, ms: 5 }));
    const probes = await probesWith(answers, [
      stat({ user: 1_000, idle: 9_000 }),
      stat(after),
    ]);

    await probes.base();

    expect(await probes.check()).toMatch(reason);
  });

  it("stays calm on a calm host", async () => {
    const answers = Array.from({ length: 20 }, () => ({ status: 200, ms: 5 }));
    const probes = await probesWith(answers, [
      stat({ user: 1_000, idle: 9_000 }),
      stat({ user: 1_010, idle: 9_088, iowait: 2 }),
    ]);

    await probes.base();

    for (let i = 0; i < 5; i += 1) expect(await probes.check()).toBeNull();
  });
});

/**
 * The fleet against a real Socket.IO server on the loopback: eight
 * origins bound to 127.0.0.2–9, a refusal with retryAfterMs, a restart that
 * drops every socket, and the summary that judges it.
 */
describe("the fleet, for real (LOAD-05)", () => {
  let io: Server | null = null;

  // Closing the Socket.IO server closes its HTTP server too.
  afterEach(async () => {
    const current = io;

    io = null;
    await new Promise((done) =>
      current ? current.close(() => done(null)) : done(null),
    );
  });

  interface Stand {
    port: number;
    addresses: string[];
    attemptsOf: Map<string, number>;
    restart: () => void;
    dropAll: () => void;
  }

  async function stand({
    refuseFirst = new Set<string>(),
    credential = new Set<string>(),
  } = {}): Promise<Stand> {
    const addresses: string[] = [];
    const attemptsOf = new Map<string, number>();

    const listen = (port = 0) =>
      new Promise<number>((done) => {
        const http: HttpServer = createServer();

        io = new Server(http, { transports: ["websocket"] });
        io.use((socket, next) => {
          const token = String(socket.handshake.auth.token);
          const count = (attemptsOf.get(token) ?? 0) + 1;

          attemptsOf.set(token, count);
          addresses.push(socket.handshake.address);

          if (credential.has(token)) return next(new Error("Token inválido"));

          if (refuseFirst.has(token) && count === 1) {
            const error = new Error("Capacidade") as Error & { data: object };

            error.data = { code: "SOCKET_UNAVAILABLE", retryAfterMs: 150 };

            return next(error);
          }

          next();
        });
        http.listen(port, "127.0.0.1", () =>
          done((http.address() as AddressInfo).port),
        );
      });

    const port = await listen();

    return {
      port,
      addresses,
      attemptsOf,
      // The process goes away and comes back on the same port.
      restart: () => {
        void io?.close();
        setTimeout(() => void listen(port), 300);
      },
      dropAll: () => io?.disconnectSockets(true),
    };
  }

  async function planFor(
    port: number,
    count: number,
    timings: { endInMs: number; restartInMs?: number },
  ) {
    const { planFleet } = await load();
    const plan = planFleet(
      {
        FLEET_URL: `http://127.0.0.1:${port}`,
        FLEET_SOCKETS: String(count),
        FLEET_SOURCE_ADDRESSES: EIGHT,
        FLEET_DURATION: "60s",
      },
      { tokens: tokens(count) },
    );
    const now = Date.now();

    // The plan's minimums are for real runs; here the clock is shorter.
    return {
      ...plan,
      shardRate: 100,
      startAtMs: now,
      endAtMs: now + timings.endInMs,
      restartAtMs:
        timings.restartInMs === undefined ? null : now + timings.restartInMs,
      restartWindowMs: 1_000,
      restartCommand: timings.restartInMs === undefined ? null : "restart",
      reconnectBaseMs: 100,
    };
  }

  it(
    "connects from eight origins, waits out retryAfterMs and is back after a restart",
    { timeout: 20_000 },
    async () => {
      const { runFleet } = await load();
      const server = await stand({ refuseFirst: new Set(["token-3"]) });
      const plan = await planFor(server.port, 16, {
        endInMs: 4_000,
        restartInMs: 1_000,
      });

      const summary = await runFleet(plan, {
        io: await loadClient(),
        restart: server.restart,
        say: () => undefined,
      });

      expect(new Set(server.addresses)).toEqual(new Set(EIGHT.split(",")));
      expect(summary.sockets).toEqual({
        planned: 16,
        connected: 16,
        neverConnected: 0,
      });
      expect(summary.handshakes.refusals.unavailable).toBe(1);
      expect(summary.handshakes.p95Ms).toBeGreaterThanOrEqual(0);
      expect(summary.drops.duringRestart).toBe(16);
      expect(summary.drops.unexpected).toBe(0);
      expect(summary.recovery.within60s).toBe(16);
      expect(summary.recovery.maxMs).toBeLessThan(60_000);
      expect(summary.origins.count).toBe(8);
      expect(summary.verdict.pass).toBe(true);
      expect(
        summary.verdict.criteria.map((criterion: any) => criterion.name),
      ).toEqual([
        "sockets conectados",
        "recusas de credencial",
        "recusas pelos limites de handshake",
        "handshakes por origem num minuto",
        "origens",
        "quedas fora do restart",
        "o restart derrubou sockets",
        "de volta em ≤ 60 s",
      ]);
    },
  );

  it("fails on a drop outside a restart", { timeout: 20_000 }, async () => {
    const { runFleet } = await load();
    const server = await stand();
    const plan = await planFor(server.port, 8, { endInMs: 2_000 });

    setTimeout(server.dropAll, 800);

    const summary = await runFleet(plan, {
      io: await loadClient(),
      say: () => undefined,
    });

    expect(summary.drops.unexpected).toBe(8);
    expect(summary.recovery.within60s).toBe(8);
    expect(summary.verdict.pass).toBe(false);
    expect(
      summary.verdict.criteria.find(
        (criterion: any) => criterion.name === "quedas fora do restart",
      ),
    ).toMatchObject({ measured: 8, pass: false });
  });

  it(
    "never retries a refused credential, and fails",
    { timeout: 20_000 },
    async () => {
      const { runFleet } = await load();
      const server = await stand({ credential: new Set(["token-0"]) });
      const plan = await planFor(server.port, 8, { endInMs: 1_500 });

      const summary = await runFleet(plan, {
        io: await loadClient(),
        say: () => undefined,
      });

      expect(server.attemptsOf.get("token-0")).toBe(1);
      expect(summary.handshakes.refusals.credential).toBe(1);
      expect(summary.sockets.connected).toBe(7);
      expect(summary.verdict.pass).toBe(false);
    },
  );
});

describe("merging the shards (LOAD-05)", () => {
  const shard = (index: number, host: string, sources: Array<string | null>) =>
    ({
      mode: "direct",
      target: "http://traefik",
      topology: null,
      shards: [`${index}/2`],
      hosts: [host],
      startedAtMs: 0,
      endedAtMs: 1_000,
      plan: { sources },
      origins: 4,
      minOrigins: 8,
      maxPerMinute: 120,
      perOrigin: 240,
      planned: 500,
      connected: 500,
      attempts: 520,
      refusals: {
        unavailable: 20,
        rateLimited: 0,
        tooManyConnections: 0,
        credential: 0,
        transport: 0,
      },
      restart: { at: "x", windowSeconds: 120, command: true },
      aborted: null,
      samples: {
        handshakeMs: [10, 20, 30],
        drops: [
          {
            atMs: 1,
            duringRestart: true,
            reason: "transport close",
            recoveredAfterMs: index === 2 ? 70_000 : 2_000,
          },
        ],
      },
    }) as const;

  it("judges the whole fleet: origins summed, every drop counted", async () => {
    const { mergeSummaries, summarize } = await load();

    const merged = mergeSummaries([
      summarize(shard(1, "a", [null])),
      summarize(shard(2, "b", [null])),
    ]);

    expect(merged.origins.count).toBe(8);
    expect(merged.sockets.planned).toBe(1_000);
    expect(merged.drops.total).toBe(2);
    expect(merged.recovery.share).toBe(0.5);
    expect(merged.verdict.pass).toBe(false);
  });

  it("refuses a set that is not one fleet", async () => {
    const { mergeSummaries, summarize } = await load();

    expect(() => mergeSummaries([summarize(shard(1, "a", [null]))])).toThrow(
      /Faltam shards: 1 de 2/,
    );
    expect(() =>
      mergeSummaries([
        summarize(shard(1, "a", [null])),
        summarize(shard(2, "a", [null])),
      ]),
    ).toThrow(/mesmo host com o endereço padrão/);
  });
});

describe("the command (LOAD-05)", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        FLEET_CONTEXT_JSON: JSON.stringify({ driverTokens: tokens(200) }),
        ...env,
      },
    });

  it("refuses 1,001 sockets through the edge on the single VPS, connecting nothing", () => {
    const result = run(["--via-edge"], edge({ FLEET_SOCKETS: "1001" }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("na VPS única o teto é 1000 sockets");
    expect(result.stdout).toBe("");
  });

  it("refuses production, whatever the mode", () => {
    const result = run([], { FLEET_URL: "https://api.intrajetto.com" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("é a produção");
  });

  it("prints the plan, without the tokens", () => {
    const result = run(["plan"], { FLEET_SOURCE_ADDRESSES: EIGHT });

    expect(result.status, result.stderr).toBe(0);

    const plan = JSON.parse(result.stdout);

    expect(plan).toMatchObject({ origins: 8, rate: 32, tokens: 200 });
    expect(result.stdout).not.toContain("token-0");
  });
});
