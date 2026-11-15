import { afterEach, describe, expect, it, vi } from "vitest";

import { Prisma, type PrismaClient } from "@prisma/client";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { isSerializationFailure } from "@/shared/errors/prisma-error-meta";

import {
  commitWriteConflict,
  queryWriteConflict,
  rawQueryWriteConflict,
} from "../../support/serialization-failure";

/**
 * The pin's transaction runs again when Postgres aborts it as a deadlock
 * victim (40P01), instead of answering the dispatcher with a 500.
 *
 * "Fixar no mapa" locks the route holding the delivery, then the delivery
 * and the copies of its point together, in id order (lockSourceAndCopies):
 * the order of a route write's updateMany by id IN (...), so the two queue
 * (tests/E2E/route-pin-deadlock.test.ts). A writer that takes the same rows
 * in separate statements against id order can still close a cycle with it,
 * and Postgres breaks the cycle by rolling one of the two back whole; when
 * that is the pin, it runs again from the top, under the budget of the
 * serializable loops of the fuel and checklist repositories (three
 * attempts), after a short pause at random. Both deadlocks are provoked
 * against Postgres in the E2E.
 *
 * The repository gets a client whose `$transaction` runs the real work over
 * a scripted transaction: each attempt answers the lock of the delivery and
 * its copies (the point the delivery holds before the pin) and the copies'
 * UPDATE, or throws there or at COMMIT the error Prisma 7 + adapter-pg
 * raises for a deadlock.
 */
vi.mock("@/../infra/database", () => ({ default: {} }));

const BUSINESS = "018fe9a0-0000-7000-8000-00000000000a";
const DELIVERY = "018fe9a0-0000-7000-8000-0000000000d1";
const COPY = "018fe9a0-0000-7000-8000-0000000000c1";

const PIN = { latitude: -22.4561, longitude: -43.1702 };

interface SourceRow {
  status: string;
  address_key: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface AttemptScript {
  /** The delivery's row as the pin's lock reads it. */
  source: SourceRow;
  /** Thrown by the copies' UPDATE, the statement a deadlock aborts. */
  atFollowers?: unknown;
  /** Thrown by the delivery's own UPDATE (a model query: P2034). */
  atPin?: unknown;
  /** Thrown after the work, as Prisma 7 throws a refused COMMIT. */
  atCommit?: unknown;
}

interface AttemptSeen {
  sourceReads: number;
  /** The values the copies' UPDATE was sent with; null when never sent. */
  followerValues: unknown[] | null;
}

const atTheDoor = (latitude: number, longitude: number): SourceRow => ({
  status: "PENDING",
  address_key: "v1:door",
  latitude,
  longitude,
});

/**
 * A client whose `$transaction` runs the repository's work over a scripted
 * transaction, attempt n following script n (the last one repeats).
 */
function scriptedClient(scripts: AttemptScript[]) {
  const seen: AttemptSeen[] = [];

  const $transaction = async (
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    const script = scripts[Math.min(seen.length, scripts.length - 1)];
    const attempt: AttemptSeen = { sourceReads: 0, followerValues: null };

    seen.push(attempt);

    const tx = {
      routeStop: { findFirst: async () => null },
      delivery: {
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          if (script.atPin) throw script.atPin;

          return {
            id: where.id,
            latitude: data.latitude,
            longitude: data.longitude,
            geo_source: data.geo_source,
            geo_updated_at: data.geo_updated_at,
          };
        },
      },
      $queryRaw: async (
        strings: TemplateStringsArray,
        ...values: Prisma.Sql[]
      ) => {
        // Flattened, nested fragments included: the text and the values as
        // Postgres would get them.
        const query = Prisma.sql(strings, ...values);

        if (query.sql.includes('UPDATE "delivery"')) {
          attempt.followerValues = query.values;

          if (script.atFollowers) throw script.atFollowers;

          return [{ id: COPY }];
        }

        if (query.sql.includes("ANY (ARRAY(")) {
          attempt.sourceReads += 1;

          // The delivery and its copy, as the lock returns them.
          return [
            { id: COPY, ...atTheDoor(-22.1, -43.1) },
            { id: DELIVERY, ...script.source },
          ];
        }

        throw new Error(`unexpected statement: ${query.sql}`);
      },
    };

    const result = await work(tx as unknown as Prisma.TransactionClient);

    if (script.atCommit) throw script.atCommit;

    return result;
  };

  return {
    repository: new RouteRepository({
      $transaction,
    } as unknown as PrismaClient),
    seen,
  };
}

const pin = (repository: RouteRepository) =>
  repository.pinDeliveryLocation(DELIVERY, BUSINESS, PIN);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a pin whose transaction Postgres aborts as a deadlock victim", () => {
  it.each([
    [
      "the copies' UPDATE (raw, P2010)",
      { atFollowers: rawQueryWriteConflict("40P01") },
    ],
    [
      "the delivery's own UPDATE (P2034)",
      { atPin: queryWriteConflict("40P01") },
    ],
    [
      "the COMMIT (the bare adapter error)",
      { atCommit: commitWriteConflict("40P01") },
    ],
  ])("runs again from the top when aborted at %s", async (_where, failure) => {
    // Between the two attempts the delivery's point changed (another pin
    // committed): the second attempt moves the copies from the point it
    // read itself, never from the one the aborted attempt read.
    const { repository, seen } = scriptedClient([
      { source: atTheDoor(-22.1, -43.1), ...failure },
      { source: atTheDoor(-22.2, -43.2) },
    ]);

    const pinned = await pin(repository);

    expect(seen).toHaveLength(2);
    expect(seen.map((attempt) => attempt.sourceReads)).toEqual([1, 1]);
    expect(seen[1].followerValues).toEqual(
      expect.arrayContaining([-22.2, -43.2]),
    );
    expect(seen[1].followerValues).not.toContain(-22.1);
    expect(pinned).toMatchObject({
      locked: false,
      delivery: { id: DELIVERY, ...PIN, geo_source: "MANUAL" },
      followed: [COPY],
    });
  });

  it("answers the deadlock after three attempts, never looping", async () => {
    const deadlock = rawQueryWriteConflict("40P01");
    const { repository, seen } = scriptedClient([
      { source: atTheDoor(-22.1, -43.1), atFollowers: deadlock },
    ]);

    await expect(pin(repository)).rejects.toBe(deadlock);
    expect(seen).toHaveLength(3);
  });

  it("runs a serialization failure (40001) again too, as the other loops do", async () => {
    const { repository, seen } = scriptedClient([
      {
        source: atTheDoor(-22.1, -43.1),
        atCommit: commitWriteConflict("40001"),
      },
      { source: atTheDoor(-22.1, -43.1) },
    ]);

    await expect(pin(repository)).resolves.toMatchObject({ followed: [COPY] });
    expect(seen).toHaveLength(2);
  });

  it.each([
    [
      "a transaction that timed out (P2028)",
      new Prisma.PrismaClientKnownRequestError("Transaction already closed", {
        code: "P2028",
        clientVersion: Prisma.prismaVersion.client,
      }),
    ],
    ["a plain error", new Error("boom")],
  ])("never runs again after %s", async (_what, error) => {
    expect(isSerializationFailure(error)).toBe(false);

    const { repository, seen } = scriptedClient([
      { source: atTheDoor(-22.1, -43.1), atFollowers: error },
      { source: atTheDoor(-22.1, -43.1) },
    ]);

    await expect(pin(repository)).rejects.toBe(error);
    expect(seen).toHaveLength(1);
  });

  it.each([
    [0, 10],
    [0.999, 49],
  ])(
    "pauses at random before running again (random %d: %d ms)",
    async (random, pauseMs) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(random);

      const { repository, seen } = scriptedClient([
        {
          source: atTheDoor(-22.1, -43.1),
          atFollowers: rawQueryWriteConflict("40P01"),
        },
        { source: atTheDoor(-22.1, -43.1) },
      ]);

      // Settled into a value at once: a rejection is asserted below, never
      // left unhandled while the clock is advanced.
      const outcome = pin(repository).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      await vi.advanceTimersByTimeAsync(pauseMs - 1);
      expect(seen).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toHaveLength(2);
      await expect(outcome).resolves.toMatchObject({
        value: { followed: [COPY] },
      });
    },
  );
});
