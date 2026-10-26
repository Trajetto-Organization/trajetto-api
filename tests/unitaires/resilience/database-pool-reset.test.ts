import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import {
  createPoolReset,
  isClosedConnection,
} from "@/shared/resilience/database-pool-reset";

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("falhou", {
    code,
    clientVersion: "6.1.0",
  });
}

function fakeClient() {
  let finish: () => void = () => {};
  const $disconnect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );

  return { $disconnect, finish: () => finish() };
}

describe("database pool reset", () => {
  it("only a closed connection (P1017) counts", () => {
    expect(isClosedConnection(prismaError("P1017"))).toBe(true);

    // Down, unreachable, saturated or a data error: a new pool fixes none.
    for (const code of ["P1001", "P1002", "P2024", "P2002", "P2010"]) {
      expect(isClosedConnection(prismaError(code))).toBe(false);
    }

    expect(
      isClosedConnection(new Error("Server has closed the connection")),
    ).toBe(false);
  });

  it("closes the pool on P1017, once for a burst, and again after it finished", async () => {
    const client = fakeClient();
    const onReset = vi.fn();
    const resetAfter = createPoolReset(client, onReset);

    resetAfter(prismaError("P2024"));
    expect(client.$disconnect).not.toHaveBeenCalled();

    resetAfter(prismaError("P1017"));
    resetAfter(prismaError("P1017"));
    resetAfter(prismaError("P1017"));

    expect(client.$disconnect).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);

    client.finish();
    await vi.waitFor(() => {
      resetAfter(prismaError("P1017"));
      expect(client.$disconnect).toHaveBeenCalledTimes(2);
    });
  });

  it("a failing disconnect or log line neither throws nor blocks the next reset", async () => {
    const $disconnect = vi.fn(() => Promise.reject(new Error("engine")));
    const resetAfter = createPoolReset({ $disconnect }, () => {
      throw new Error("log");
    });

    expect(() => resetAfter(prismaError("P1017"))).not.toThrow();

    await vi.waitFor(() => {
      resetAfter(prismaError("P1017"));
      expect($disconnect).toHaveBeenCalledTimes(2);
    });
  });
});
