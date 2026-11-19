import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { container } from "tsyringe";

import { env } from "@/env";
import { tenantSnapshotMemory } from "@/shared/cache/tenant-snapshot";
import type { UploadService } from "@/shared/services/upload-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";
import { createPrismaClient } from "@/shared/database/database-client";
import { operationDay } from "@/shared/route/operation-day-rules";

import { fakeJpeg, seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * What the panel's hottest reads and the driver's submissions cost the
 * database, pinned to the statement (plano-escala F4-06).
 *
 * Every open tab of the control tower asks for the tower, the operation
 * summary and the bell at each tick; the manager's phone polls /route/live;
 * the overview and its trend chart open with every visit to the panel's
 * home; the deliveries list is the page people work on; and every stop of
 * every driver ends in an arrival and a proof. Together they are most of
 * what the primary answers, so their statement count is the cost per
 * request the scale plan budgets (10.68 statements a request measured in
 * ADR 0011, at most 7 the goal of F4-07).
 *
 * Each route has its number, measured, and the test asks for exactly that
 * number. One statement more fails: a new query on a hot path is a
 * decision, written down here with its why, not something a refactor
 * slips in (the full user read twice on every request did, until the
 * request memo of request-context.ts). One fewer fails too, asking for the
 * number to be lowered in the same commit: a budget left above the real
 * count lets the next statement in unseen.
 *
 * Counted like driver-positions-statement-budget: a logging client goes on
 * globalThis before the app is imported, so every repository, the read
 * bulkhead and the batch pool talk through it (infra/database.ts). A
 * request's window closes once the database has been quiet for QUIET_MS:
 * what a request leaves running after its answer (the activity line of a
 * submission) is its cost too, counted with it and never with the next
 * one. The BEGIN/COMMIT around a transaction are not work of their own.
 *
 * The session is the one statement of SESSION_LOOKUP_MODE=single, the
 * default since F4-05; legacy, the rollback, is budgeted in
 * session-statement-budget. The data is one carrier's day: a route on the
 * road with a delivered stop, the driver on the map, a queue of deliveries
 * for the list, unread rows in the bell, and no ERP subscribed to webhooks
 * (a subscription adds its rows to every proof, by design).
 */
const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;

const CARRIER = "018fdd32-0000-7000-8000-00000000000a";

const statements: string[] = [];
const storedKeys: string[] = [];

/** The stops of the route on the road, in order. */
const stops: string[] = [];

let driverToken = "";
let managerToken = "";

const initialMode = env.SESSION_LOOKUP_MODE;
const initialTowerTtl = env.TOWER_SNAPSHOT_TTL_MS;

/**
 * How long the database must stay quiet for a request's window to close.
 * The wait is for that state: it lasts as long as statements keep coming.
 */
const QUIET_MS = 300;

/** The one statement of SessionRepository.loadSession. */
const isSessionStatement = (sql: string) =>
  sql.includes('AS "hasActiveFamily"');

const isTransactionControl = (sql: string) =>
  /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql);

/** The activity line a submission writes after its answer. */
const isActivityWrite = (sql: string) =>
  sql.startsWith('INSERT INTO "public"."activity"');

async function quiet(): Promise<void> {
  const deadline = Date.now() + 15_000;
  let seen = -1;

  while (seen !== statements.length) {
    if (Date.now() > deadline) {
      throw new Error("The database never went quiet after the request.");
    }

    seen = statements.length;
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  }
}

/** The statements one request sent, from its start to the quiet after it. */
async function cost<
  Answer extends { statusCode: number; body: string } = {
    statusCode: number;
    body: string;
  },
>(
  send: () => Promise<Answer>,
  lastWrite: (sql: string) => boolean = () => true,
) {
  statements.length = 0;

  const response = await send();

  // The work a request leaves for after its answer, waited for by what it
  // writes last, then the quiet that closes the window.
  await vi.waitFor(() => expect(statements.some(lastWrite)).toBe(true), {
    timeout: 15_000,
  });
  await quiet();

  const work = statements.filter((sql) => !isTransactionControl(sql));

  return { response, work, trace: work.join("\n") };
}

function pings(count: number) {
  const now = Date.now();

  return Array.from({ length: count }, (_, index) => ({
    latitude: -23.55 + index * 0.0001,
    longitude: -46.63 + index * 0.0001,
    accuracy: 10,
    speed: 30,
    heading: 90,
    battery: 80,
    recorded_at: new Date(now - (count - index) * 15_000).toISOString(),
  }));
}

async function storedPhoto(): Promise<string> {
  const key = `deliveryPhotos/${CARRIER}/${Date.now()}-budget-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

const arrival = (deliveryId: string) => () =>
  app.inject({
    method: "POST",
    url: `/delivery/arrival/${deliveryId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${driverToken}` },
    payload: {
      client_submission_id: randomUUID(),
      latitude: -23.55,
      longitude: -46.63,
    },
  });

const proof = (deliveryId: string, photo: string) => () =>
  app.inject({
    method: "POST",
    url: `/delivery/proof/${deliveryId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${driverToken}` },
    payload: {
      client_submission_id: randomUUID(),
      photo,
      received_by: "João",
    },
  });

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
  });

  driverToken = seed.driverToken;
  managerToken = seed.managerToken;

  await ensureDefaultOccurrenceTypes(prisma, CARRIER);

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });

  // A route of the company's today, started today: one that started
  // yesterday is `stale` on the tower, another shape. The seed's company
  // keeps the schema's default zone.
  const today = operationDay("America/Sao_Paulo", new Date());

  const route = await prisma.route.create({
    data: {
      code: 1,
      status: "IN_PROGRESS",
      scheduled_date: new Date(`${today.date}T00:00:00.000Z`),
      started_at: new Date(
        Math.max(today.start.getTime(), Date.now() - 30 * 60_000),
      ),
      businessId: CARRIER,
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
    },
  });

  // Six stops: the first is delivered below, the second is measured, and
  // the route stays open after it (closing the route is another cost).
  for (let index = 0; index < 6; index++) {
    const delivery = await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId: shipper.id,
        code: `PAINEL-${index}`,
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "IN_TRANSIT",
        driverId: seed.driverId,
      },
    });

    await prisma.routeStop.create({
      data: { routeId: route.id, deliveryId: delivery.id, sequence: index + 1 },
    });

    stops.push(delivery.id);
  }

  // The list's queue: older than the route's deliveries, one in three
  // delivered by the driver, so both pages of 20 carry rows with and
  // without a driver.
  await prisma.delivery.createMany({
    data: Array.from({ length: 25 }, (_, index) => {
      const created = new Date(Date.now() - (index + 1) * 60_000);
      const delivered = index % 3 === 0;

      return {
        businessId: CARRIER,
        shipperId: shipper.id,
        code: `FILA-${index}`,
        recipient_name: `Cliente ${index}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: delivered ? ("DELIVERED" as const) : ("PENDING" as const),
        driverId: delivered ? seed.driverId : null,
        delivered_at: delivered ? created : null,
        created_at: created,
      };
    }),
  });

  const manager = await prisma.user.findFirstOrThrow({
    where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
  });

  await prisma.notification.createMany({
    data: Array.from({ length: 5 }, (_, index) => ({
      type: "delivery",
      title: `Aviso ${index}`,
      message: "Uma entrega mudou",
      userId: manager.id,
      businessId: CARRIER,
      read: index % 2 === 0,
    })),
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");

  env.SESSION_LOOKUP_MODE = "single";

  // The tower, the summary and /route/live are measured on their query
  // path, each read computing in its request; their snapshot (F4-11) has
  // budgets of its own below.
  env.TOWER_SNAPSHOT_TTL_MS = 0;

  // The day so far, through the app: the driver on the map, and the first
  // stop arrived at and delivered.
  const flush = await app.inject({
    method: "POST",
    url: "/route/positions",
    headers: { authorization: `Bearer ${driverToken}` },
    payload: { pings: pings(10) },
  });

  expect(flush.statusCode, flush.body).toBe(200);

  const arrived = await cost(arrival(stops[0]!), isActivityWrite);
  const delivered = await cost(
    proof(stops[0]!, await storedPhoto()),
    isActivityWrite,
  );

  expect(arrived.response.statusCode, arrived.response.body).toBe(201);
  expect(delivered.response.statusCode, delivered.response.body).toBe(201);
}, 180_000);

afterAll(async () => {
  env.SESSION_LOOKUP_MODE = initialMode;
  env.TOWER_SNAPSHOT_TTL_MS = initialTowerTtl;

  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
  await counted.$disconnect();
}, 60_000);

/**
 * The panel's reads, each with its budget and what its statements are. The
 * session's one statement is in every budget, and since F4-07 it brings the
 * company's zone too: no read below asks for it again.
 */
const READS = [
  {
    // The latest positions, the routes of the day with
    // their drivers, vehicles and stops, the day's counts, then the feed:
    // events, occurrences and their routes, the occurrences awaiting
    // authorization with their types, deliveries and drivers, the routes'
    // milestones; and the open pauses.
    route: "GET /route/control-tower",
    url: "/route/control-tower",
    budget: 16,
  },
  {
    // The day's counts, the drivers, the unassigned deliveries, the day's
    // occurrences and the routes left open since another day.
    route: "GET /delivery/operation-summary",
    url: "/delivery/operation-summary",
    budget: 6,
  },
  {
    // The routes with their counts and positions in one query, and the
    // page's pending authorizations.
    route: "GET /route/live",
    url: "/route/live",
    budget: 3,
  },
  {
    // The registries' totals and months, the fleet by status,
    // by maintenance standing and by type (with the types' names), the
    // maintenance costs, the operation of the day (counts, drivers,
    // unassigned, occurrences) and the recent activity with who did it.
    route: "GET /dashboard/overview",
    url: "/dashboard/overview",
    budget: 16,
  },
  {
    // The company's modules, the registries' series and the work's.
    route: "GET /dashboard/trends",
    url: "/dashboard/trends?period=30d",
    budget: 4,
  },
  {
    // The page of the bell, its unread count and its total.
    route: "GET /notification/stream",
    url: "/notification/stream?limit=50",
    budget: 4,
  },
  {
    // The counts by status, shipper and driver in one grouped
    // read, the page with its drivers and shippers, the filters' shippers
    // and drivers, and the routes left open since another day.
    route: "GET /delivery/list-delivery, page 1",
    url: "/delivery/list-delivery?page=1&pageSize=20",
    budget: 8,
  },
  {
    // The next page under the same filters (plano-escala F2-30): the
    // page and its drivers and shippers, no counts.
    route: "GET /delivery/list-delivery, page 2 without the counts",
    url: "/delivery/list-delivery?page=2&pageSize=20&facets=skip",
    budget: 4,
  },
] as const;

describe("the panel's hot reads", () => {
  it.each(READS)("$route costs $budget statements", async ({ url, budget }) => {
    const { response, work, trace } = await cost(() =>
      app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${managerToken}` },
      }),
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(work.filter(isSessionStatement), trace).toHaveLength(1);
    expect(work.length, trace).toBe(budget);
  });
});

/**
 * The tower, the summary and the first page of /route/live through the
 * company's snapshot (plano-escala F4-11). The read that computes costs the
 * route's statements plus the company's zone: the computation runs outside
 * the request, where the zone the session brought is not. Every read the
 * copy serves, and every 304, costs the session alone.
 */
const SNAPSHOT_READS = READS.filter(({ url }) =>
  [
    "/route/control-tower",
    "/delivery/operation-summary",
    "/route/live",
  ].includes(url),
);

describe("the panel's hot reads through the company's snapshot", () => {
  beforeAll(() => {
    env.TOWER_SNAPSHOT_TTL_MS = 10_000;
    tenantSnapshotMemory().clear();
  });

  afterAll(() => {
    env.TOWER_SNAPSHOT_TTL_MS = 0;
  });

  const read =
    (url: string, headers: Record<string, string> = {}) =>
    () =>
      app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${managerToken}`, ...headers },
      });

  it.each(SNAPSHOT_READS)(
    "$route costs one more to compute, and the session alone from the copy",
    async ({ url, budget }) => {
      const computed = await cost(read(url));

      expect(computed.response.statusCode, computed.response.body).toBe(200);
      expect(
        computed.work.filter(isSessionStatement),
        computed.trace,
      ).toHaveLength(1);
      expect(computed.work.length, computed.trace).toBe(budget + 1);

      const copy = await cost(read(url));

      expect(copy.response.statusCode).toBe(200);
      expect(copy.response.body).toBe(computed.response.body);
      expect(copy.work.filter(isSessionStatement), copy.trace).toHaveLength(1);
      expect(copy.work.length, copy.trace).toBe(1);

      const etag = String(computed.response.headers.etag);
      const notModified = await cost(read(url, { "if-none-match": etag }));

      expect(notModified.response.statusCode).toBe(304);
      expect(notModified.work.length, notModified.trace).toBe(1);
    },
  );
});

describe("the driver's submissions at a stop", () => {
  // The submission's key twice (the replay check), the delivery, the
  // company's settings, the event and its key, the stop under the route's
  // lock, the route's progress, and the activity line after the answer.
  it("an arrival costs 15 statements", async () => {
    const { response, work, trace } = await cost(
      arrival(stops[1]!),
      isActivityWrite,
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(work.filter(isSessionStatement), trace).toHaveLength(1);
    expect(work.length, trace).toBe(15);
  });

  // The arrival's reads plus the DELIVERED occurrence it records (its type,
  // the replay of an earlier report), the delivery's new status, the
  // event, the stop and the route's progress, the ERP's subscriptions
  // (none here), the proof's audit card, and the activity line.
  it("a proof costs 30 statements", async () => {
    const photo = await storedPhoto();
    const { response, work, trace } = await cost(
      proof(stops[1]!, photo),
      isActivityWrite,
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(work.filter(isSessionStatement), trace).toHaveLength(1);
    expect(work.length, trace).toBe(30);
  });
});
