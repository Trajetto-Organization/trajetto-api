import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import { envSchema } from "@/schemas/env-schema";
import { InMemoryDriverPositionRepository } from "@/modules/route/repositories/in-memory/in-memory-driver-position-repository";
import { InMemoryOperationDayRepository } from "@/modules/route/repositories/in-memory/in-memory-operation-day-repository";
import {
  ControlTowerUseCase,
  controlTowerSnapshot,
} from "@/modules/route/usecases/control-tower/control-tower-usecase";
import { TOWER_SNAPSHOT_MIN_REFRESH_MS } from "@/modules/route/usecases/control-tower/tower-snapshot";
import {
  LiveRoutesUseCase,
  liveRoutesSnapshot,
} from "@/modules/route/usecases/live-routes/live-routes-usecase";
import { operationSummarySnapshot } from "@/modules/delivery/usecases/operation-summary/operation-summary-usecase";

/**
 * The tower, the summary and the first page of /route/live through the
 * company's snapshot (plano-escala F4-11, decision D2). A copy is the
 * company's: it is served only after the caller was checked, on every
 * request, and never to another company. The HTTP proof, with Postgres and
 * the guards of the route, is tests/E2E/control-tower-snapshot-http.test.ts.
 */
const SP = "018f0000-0000-7000-8000-00000000c001";
const ACRE = "018f0000-0000-7000-8000-00000000c002";

const MANAGER = {
  id: "manager",
  businessId: SP,
  role: "BUSINESS_ADMIN",
  driverId: null,
};
const COLLEAGUE = {
  id: "colleague",
  businessId: SP,
  role: "BUSINESS_USER",
  driverId: null,
};
const ACRE_MANAGER = {
  id: "acre",
  businessId: ACRE,
  role: "BUSINESS_ADMIN",
  driverId: null,
};
const MASTER = {
  id: "master",
  businessId: null,
  role: "MASTER",
  driverId: null,
};
const DRIVER_USER = {
  id: "driver-user",
  businessId: SP,
  role: "BUSINESS_USER",
  driverId: "d1",
};

const users = [MANAGER, COLLEAGUE, ACRE_MANAGER, MASTER, DRIVER_USER];

const userRepository = {
  findUserById: async (id: string) =>
    users.find((user) => user.id === id) ?? null,
} as never;

const authorizations = {
  countPendingByRoute: async () => new Map<string, number>(),
} as never;

const initialTtl = env.TOWER_SNAPSHOT_TTL_MS;

let operation: InMemoryOperationDayRepository;
let positions: InMemoryDriverPositionRepository;

beforeEach(() => {
  env.TOWER_SNAPSHOT_TTL_MS = 10_000;

  operation = new InMemoryOperationDayRepository();
  positions = new InMemoryDriverPositionRepository();

  operation.rows.businesses.push(
    { id: SP, timezone: "America/Sao_Paulo" },
    { id: ACRE, timezone: "America/Rio_Branco" },
  );
});

afterEach(() => {
  env.TOWER_SNAPSHOT_TTL_MS = initialTtl;
});

const tower = () =>
  new ControlTowerUseCase(userRepository, positions, operation);

const live = () =>
  new LiveRoutesUseCase(userRepository, operation, authorizations);

const asBody = (value: unknown) => JSON.stringify({ data: value });

describe("TOWER_SNAPSHOT_TTL_MS", () => {
  const base = {
    NODE_ENV: "test",
    REDIS_URL: "redis://redis:6379",
    HTTP_REQUEST: "https://app.example.com",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
    UPLOAD_STORAGE_TYPE: "local",
  };

  it("is 10 s when absent or empty, and 0 turns the snapshot off", () => {
    for (const value of [undefined, ""]) {
      expect(
        envSchema.parse({ ...base, TOWER_SNAPSHOT_TTL_MS: value })
          .TOWER_SNAPSHOT_TTL_MS,
      ).toBe(10_000);
    }

    expect(
      envSchema.parse({ ...base, TOWER_SNAPSHOT_TTL_MS: "0" })
        .TOWER_SNAPSHOT_TTL_MS,
    ).toBe(0);
    expect(
      envSchema.parse({ ...base, TOWER_SNAPSHOT_TTL_MS: "60000" })
        .TOWER_SNAPSHOT_TTL_MS,
    ).toBe(60_000);
  });

  it("refuses a negative, fractional or longer-than-a-minute interval", () => {
    for (const value of ["-1", "1.5", "60001", "10s"]) {
      expect(
        envSchema.safeParse({ ...base, TOWER_SNAPSHOT_TTL_MS: value }).success,
        value,
      ).toBe(false);
    }
  });

  it("is read on every request: 0 turns the three snapshots off without a new instance", () => {
    const snapshots = [
      controlTowerSnapshot,
      operationSummarySnapshot,
      liveRoutesSnapshot,
    ];

    expect(snapshots.map((snapshot) => snapshot.enabled)).toEqual([
      true,
      true,
      true,
    ]);

    env.TOWER_SNAPSHOT_TTL_MS = 0;

    expect(snapshots.map((snapshot) => snapshot.enabled)).toEqual([
      false,
      false,
      false,
    ]);
    expect(snapshots.map((snapshot) => snapshot.stats().name)).toEqual([
      "control-tower",
      "operation-summary",
      "route-live",
    ]);
    expect(TOWER_SNAPSHOT_MIN_REFRESH_MS).toBe(2_000);
  });
});

describe("the tower through the company's snapshot", () => {
  it("serves a second manager of the company the copy, computed once", async () => {
    const routes = vi.spyOn(operation, "listTowerRoutes");

    const first = await tower().executeSnapshot({
      userId: MANAGER.id,
      refresh: false,
      body: asBody,
    });
    const second = await tower().executeSnapshot({
      userId: COLLEAGUE.id,
      refresh: false,
      body: asBody,
    });

    expect(first.source).toBe("computed");
    expect(second).toEqual({ ...first, source: "copy" });
    expect(JSON.parse(first.body).data.timeZone).toBe("America/Sao_Paulo");
    expect(routes).toHaveBeenCalledTimes(1);
  });

  it("checks the caller before the copy on every read, and a refused caller reads nothing", async () => {
    await tower().executeSnapshot({
      userId: MANAGER.id,
      refresh: false,
      body: asBody,
    });

    const routes = vi.spyOn(operation, "listTowerRoutes");
    const read = (userId: string, businessId?: string) =>
      tower().executeSnapshot({
        userId,
        businessId,
        refresh: false,
        body: asBody,
      });

    await expect(read(DRIVER_USER.id)).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CANNOT_VIEW_PANELS",
    });
    await expect(read(ACRE_MANAGER.id, SP)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(read(MASTER.id)).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
    await expect(read("nobody")).rejects.toMatchObject({ statusCode: 404 });

    expect(routes).not.toHaveBeenCalled();
  });

  it("never serves one company's copy to another, and gives a MASTER the company named", async () => {
    const sp = await tower().executeSnapshot({
      userId: MANAGER.id,
      refresh: false,
      body: asBody,
    });
    const acre = await tower().executeSnapshot({
      userId: ACRE_MANAGER.id,
      refresh: false,
      body: asBody,
    });
    const named = await tower().executeSnapshot({
      userId: MASTER.id,
      businessId: SP,
      refresh: false,
      body: asBody,
    });

    expect(acre.source).toBe("computed");
    expect(JSON.parse(acre.body).data.timeZone).toBe("America/Rio_Branco");
    expect(acre.etag).not.toBe(sp.etag);
    expect(named).toEqual({ ...sp, source: "copy" });
  });

  it("computes in the caller's request when it is off, as execute does", async () => {
    env.TOWER_SNAPSHOT_TTL_MS = 0;

    const routes = vi.spyOn(operation, "listTowerRoutes");

    const reads = [
      await tower().executeSnapshot({
        userId: ACRE_MANAGER.id,
        refresh: false,
        body: asBody,
      }),
      await tower().executeSnapshot({
        userId: ACRE_MANAGER.id,
        refresh: false,
        body: asBody,
      }),
    ];

    expect(reads.map((read) => read.source)).toEqual(["off", "off"]);
    expect(routes).toHaveBeenCalledTimes(2);
  });
});

describe("the first page of /route/live through the company's snapshot", () => {
  it("checks the caller before the copy, and keeps each company apart", async () => {
    const rows = vi.spyOn(operation, "listLiveRoutes");

    const first = await live().executeSnapshot({
      userId: MANAGER.id,
      refresh: false,
      body: (page) => JSON.stringify(page),
    });
    const again = await live().executeSnapshot({
      userId: COLLEAGUE.id,
      refresh: false,
      body: (page) => JSON.stringify(page),
    });

    expect(first.source).toBe("computed");
    expect(again.source).toBe("copy");
    expect(rows).toHaveBeenCalledTimes(1);
    expect(rows).toHaveBeenCalledWith(
      SP,
      expect.objectContaining({ after: undefined }),
    );

    await expect(
      live().executeSnapshot({
        userId: DRIVER_USER.id,
        refresh: false,
        body: (page) => JSON.stringify(page),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const acre = await live().executeSnapshot({
      userId: ACRE_MANAGER.id,
      refresh: false,
      body: (page) => JSON.stringify(page),
    });

    expect(JSON.parse(acre.body).meta.timeZone).toBe("America/Rio_Branco");
    expect(rows).toHaveBeenCalledTimes(2);
  });
});
