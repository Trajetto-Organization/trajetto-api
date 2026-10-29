import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * bcrypt with nothing in front of it.
 *
 * The native binding runs every hash and compare on libuv's threadpool — four
 * threads by default, the same four that serve gzip for every response over
 * 1 KB, `fs` and `dns.lookup`. Each login is ~55 ms of that pool, and nothing
 * bounded how many could be queued: a credential-stuffing run (a per-address
 * limit is no limit for a botnet) queued work without end, and measured with
 * 80 operations queued a DNS lookup took 553 ms and a 64 KB gzip 562 ms. Every
 * provider timeout (push, WhatsApp, webhooks) starts before its DNS lookup.
 *
 * Every bcrypt call now goes through one gate per process: two at a time, a
 * short queue, and a fast 503 beyond that, so bcrypt can never hold more than
 * two threads of the pool nor queue unbounded work.
 */

interface Pending {
  resolve: (value: unknown) => void;
  plain: string;
}

const inFlight: Pending[] = [];
let peak = 0;

function track(plain: string) {
  return new Promise((resolvePromise) => {
    inFlight.push({ resolve: resolvePromise, plain });
    peak = Math.max(peak, inFlight.length);
  }).finally(() => {
    const index = inFlight.findIndex((entry) => entry.plain === plain);
    if (index >= 0) inFlight.splice(index, 1);
  });
}

vi.mock("bcrypt", () => ({
  compare: vi.fn((plain: string) => track(plain)),
  hash: vi.fn((plain: string) => track(plain)),
}));

import { compare, hash } from "bcrypt";

import {
  compareSecret,
  createSecretGate,
  gateStats,
  hashSecret,
} from "@/shared/security/bcrypt-gate";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { AppError } from "@/shared/errors/AppError";

/** Lets the gate hand a freed slot over before the next assertion. */
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

async function settleAll() {
  // Resolve whatever is running, over and over, until the gate is idle. The
  // first tick lets a just-admitted call reach bcrypt.
  await tick();

  for (
    let round = 0;
    round < 200 && (inFlight.length > 0 || gateStats().active > 0);
    round += 1
  ) {
    for (const entry of [...inFlight]) entry.resolve(true);
    await tick();
  }
}

beforeEach(async () => {
  await settleAll();
  inFlight.length = 0;
  peak = 0;
  vi.mocked(compare).mockClear();
  vi.mocked(hash).mockClear();
});

describe("the process-wide gate", () => {
  it("never lets more than two bcrypt operations run at once", async () => {
    const calls = Array.from({ length: 30 }, (_, index) =>
      compareSecret(`senha-${index}`, "$2b$10$hash"),
    );

    await tick();
    expect(inFlight).toHaveLength(2);

    await settleAll();
    await Promise.all(calls);

    expect(peak).toBe(2);
    expect(compare).toHaveBeenCalledTimes(30);
  });

  it("refuses at once, with a 503 that says when to come back, once the queue is full", async () => {
    const outcomes = Array.from({ length: 60 }, (_, index) =>
      compareSecret(`tentativa-${index}`, "$2b$10$hash").then(
        () => "ok" as const,
        (error: unknown) => error,
      ),
    );

    await tick();

    // Two running, fifty waiting: the rest are refused without queuing.
    const stats = gateStats();
    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(50);

    await settleAll();
    const results = await Promise.all(outcomes);

    const refused = results.filter(
      (result) => result instanceof ServiceBusyError,
    );
    expect(refused).toHaveLength(8);

    // The ones refused are the LAST eight: the queue is FIFO, and a request
    // already waiting is not overtaken by one that arrived later.
    expect(results.slice(0, 52).every((result) => result === "ok")).toBe(true);

    const error = refused[0] as ServiceBusyError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("AUTH_BUSY");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);

    // A refused call never reached bcrypt.
    expect(compare).toHaveBeenCalledTimes(52);
  });

  it("serves the queue in arrival order", async () => {
    const order: number[] = [];

    const calls = Array.from({ length: 6 }, (_, index) =>
      hashSecret(`ordem-${index}`).then(() => order.push(index)),
    );

    await settleAll();
    await Promise.all(calls);

    expect(vi.mocked(hash).mock.calls.map(([plain]) => plain)).toEqual([
      "ordem-0",
      "ordem-1",
      "ordem-2",
      "ordem-3",
      "ordem-4",
      "ordem-5",
    ]);
  });

  it("hashes with cost 10 unless told otherwise", async () => {
    const pending = hashSecret("senha-forte");
    await settleAll();
    await pending;

    expect(hash).toHaveBeenCalledWith("senha-forte", 10);
  });

  it("frees the slot when bcrypt fails", async () => {
    vi.mocked(compare).mockImplementationOnce(
      () => Promise.reject(new Error("invalid salt")) as never,
    );

    await expect(compareSecret("x", "garbage")).rejects.toThrow("invalid salt");
    expect(gateStats().active).toBe(0);
  });
});

describe("a gate of its own", () => {
  it("honours its own limits", async () => {
    const gate = createSecretGate({ maxConcurrent: 1, maxQueued: 1 });

    const first = gate.compare("a", "$2b$10$h");
    const second = gate.compare("b", "$2b$10$h");
    const third = gate.compare("c", "$2b$10$h");

    await expect(third).rejects.toBeInstanceOf(ServiceBusyError);
    expect(gate.stats()).toMatchObject({ active: 1, queued: 1 });

    await settleAll();
    await Promise.all([first, second]);
  });
});

describe("no direct bcrypt left", () => {
  it("nothing in src/ but the gate itself imports bcrypt", () => {
    // The whole tree, not a list of today's callers: the next use case that
    // hashes a password must not be able to walk around the gate unnoticed.
    const root = resolve(__dirname, "../../..");
    const gate = join("src", "shared", "security", "bcrypt-gate.ts");

    const offenders = (
      readdirSync(join(root, "src"), { recursive: true }) as string[]
    )
      .map((entry) => join("src", entry))
      .filter((path) => /\.ts$/.test(path) && path !== gate)
      .filter((path) =>
        /from\s+["']bcrypt(js)?["']|require\(\s*["']bcrypt(js)?["']\s*\)/.test(
          readFileSync(join(root, path), "utf8"),
        ),
      );

    expect(offenders).toEqual([]);
  });
});

describe("the image", () => {
  it("gives libuv more than four threads, so bcrypt's two leave room for gzip, fs and DNS", () => {
    const dockerfile = readFileSync(
      resolve(__dirname, "../../../Dockerfile"),
      "utf8",
    );

    const runner = dockerfile.slice(dockerfile.indexOf("FROM base AS runner"));

    expect(runner).toMatch(/^ENV UV_THREADPOOL_SIZE=8$/m);
  });
});
