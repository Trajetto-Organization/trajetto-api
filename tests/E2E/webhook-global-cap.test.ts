import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { env } from "@/env";
import { WebhookEndpointRepository } from "@/modules/integration/repositories/webhook-endpoint-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  WEBHOOK_CLAIM_MAX_ENDPOINTS,
  destinationHostOf,
} from "@/shared/integration/webhook-dispatch-rules";
import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";

/**
 * The global cap per endpoint (plano-escala F3-13; decision D8).
 *
 * The cap of calls in flight to one endpoint was per process
 * (WEBHOOK_PER_ENDPOINT_CONCURRENCY, 2): three dispatchers sent six at
 * once to the same ERP, and a worker ×2 would have doubled what a
 * receiver sized for four took. Here three dispatchers drain one endpoint
 * against a real receiver that counts the requests it holds open.
 *
 *  - under WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY=4, the receiver never holds
 *    more than four, and every event still arrives (and, with the cap
 *    off, the claim of before lets the three send six at once: red);
 *  - a second endpoint's events go out while the first is at its cap;
 *  - the cap is read at every claim;
 *  - F3-14: the endpoints of one destination host (an aggregator's ERP)
 *    never hold more than WEBHOOK_HOST_GLOBAL_CONCURRENCY open on it
 *    together, an endpoint with no host recorded has no host cap, and the
 *    host is written with the URL and filled for the endpoints without;
 *  - more endpoints with nothing to take than one walk visits (rows parked
 *    for 30 days, an aggregator's host at its cap) never hold back the
 *    endpoints after them, the lap wraps up to the cursor it started from,
 *    and it closes, claiming nothing, when nothing is due.
 */
const prisma = createPrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000013ca";

/** How long the receiver holds each request open. */
const HOLD_MS = 250;

let server: Server;
let baseUrl: string;

/** Requests open now and at most, per path and in all; arrivals in order. */
const open = new Map<string, number>();
const peak = new Map<string, number>();
let openTotal = 0;
let peakTotal = 0;
let arrivals: string[] = [];

const saved = {
  endpoint: env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY,
  host: env.WEBHOOK_HOST_GLOBAL_CONCURRENCY,
};

/** Three dispatchers, as three worker processes would run them. */
function dispatchers(): WebhookDispatchService[] {
  return [1, 2, 3].map(
    () => new WebhookDispatchService(async () => ({ allowed: true })),
  );
}

async function seedEndpoint(
  path: string,
  options: { withHost?: boolean } = {},
): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `Receptor ${path}`,
      url: `${baseUrl}${path}`,
      destination_host: options.withHost
        ? destinationHostOf(`${baseUrl}${path}`)
        : null,
      secret: "whsec_teste_do_teto_global",
      topics: ["delivery.delivered"],
      businessId: CARRIER,
      is_active: true,
    },
  });

  return endpoint.id;
}

async function queueEvents(count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: `entrega-${n}`, code: `PED-${n}` },
    });
  }
}

/**
 * Every dispatcher, cycle after cycle, until nothing is left. Each starts
 * 50 ms after the one before, as processes whose sweeps are not in step:
 * claims at the same instant collide on the same rows and all but one
 * come back empty, which hid the multiplication this file is about.
 */
async function drainWith(all: WebhookDispatchService[]): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    await Promise.all(
      all.map(async (dispatcher, index) => {
        await new Promise((resolve) => setTimeout(resolve, index * 50));
        await dispatcher.processBatch();
      }),
    );

    const left = await prisma.webhookDelivery.count({
      where: { businessId: CARRIER, status: { in: ["PENDING", "PROCESSING"] } },
    });

    if (left === 0) return;
  }

  throw new Error("the dispatchers did not drain the queue");
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";

    request.resume();

    request.on("end", () => {
      const now = (open.get(path) ?? 0) + 1;

      open.set(path, now);
      peak.set(path, Math.max(peak.get(path) ?? 0, now));
      openTotal += 1;
      peakTotal = Math.max(peakTotal, openTotal);
      arrivals.push(path);

      setTimeout(() => {
        open.set(path, (open.get(path) ?? 1) - 1);
        openTotal -= 1;
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("ok");
      }, HOLD_MS);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Teto Global",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000155",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "teto-global@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  open.clear();
  peak.clear();
  openTotal = 0;
  peakTotal = 0;
  arrivals = [];
  env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY = 4;
  env.WEBHOOK_HOST_GLOBAL_CONCURRENCY = 16;

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY = saved.endpoint;
  env.WEBHOOK_HOST_GLOBAL_CONCURRENCY = saved.host;

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("three dispatchers and one endpoint", () => {
  it("never hold more requests open on it than the global cap", async () => {
    await seedEndpoint("/a");
    await queueEvents(24);

    await drainWith(dispatchers());

    expect(arrivals.filter((path) => path === "/a")).toHaveLength(24);
    expect(peak.get("/a")).toBeLessThanOrEqual(4);

    // The cap is the endpoint's, not one process's: more than one
    // dispatcher sends to it at once.
    expect(peak.get("/a")).toBeGreaterThan(2);

    const delivered = await prisma.webhookDelivery.count({
      where: { businessId: CARRIER, status: "DELIVERED" },
    });

    expect(delivered).toBe(24);
  }, 60_000);

  it("sent past it with the cap off, each process counting only its own", async () => {
    // The claim of before, which a 0 brings back: three processes at 2
    // calls each.
    env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY = 0;

    await seedEndpoint("/a");
    await queueEvents(24);

    await drainWith(dispatchers());

    expect(arrivals.filter((path) => path === "/a")).toHaveLength(24);
    expect(peak.get("/a")).toBeGreaterThan(4);
  }, 60_000);

  it("follows the cap read at each claim", async () => {
    env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY = 1;

    await seedEndpoint("/a");
    await queueEvents(6);

    await drainWith(dispatchers());

    expect(arrivals).toHaveLength(6);
    expect(peak.get("/a")).toBe(1);
  }, 60_000);
});

describe("an endpoint at its cap", () => {
  it("does not hold another endpoint's events behind its own", async () => {
    await seedEndpoint("/a");
    await seedEndpoint("/b");

    // Every event goes to both endpoints: 20 rows each.
    await queueEvents(20);

    await drainWith(dispatchers());

    expect(peak.get("/a")).toBeLessThanOrEqual(4);
    expect(peak.get("/b")).toBeLessThanOrEqual(4);

    // B's twenty arrived alongside A's, not after them: by the time half
    // of A's had arrived, so had most of B's.
    const halfOfA = arrivals.findIndex(
      (_, index) =>
        arrivals.slice(0, index + 1).filter((path) => path === "/a").length ===
        10,
    );
    const bBeforeHalfOfA = arrivals
      .slice(0, halfOfA + 1)
      .filter((path) => path === "/b").length;

    expect(bBeforeHalfOfA).toBeGreaterThanOrEqual(6);
  }, 60_000);
});

describe("the endpoints of one destination host (F3-14)", () => {
  // Six endpoints on one server, as an aggregator's ERP receives one
  // endpoint per tenant: the cap per endpoint alone lets them hold 6 × 4
  // open on it at once.
  const PATHS = ["/h1", "/h2", "/h3", "/h4", "/h5", "/h6"];

  it("never hold more requests open on it together than the host cap", async () => {
    env.WEBHOOK_HOST_GLOBAL_CONCURRENCY = 5;

    for (const path of PATHS) await seedEndpoint(path, { withHost: true });

    await queueEvents(6);
    await drainWith(dispatchers());

    expect(arrivals).toHaveLength(36);
    expect(peakTotal).toBeLessThanOrEqual(5);
  }, 90_000);

  it("held more than that with the host cap off", async () => {
    env.WEBHOOK_HOST_GLOBAL_CONCURRENCY = 0;

    for (const path of PATHS) await seedEndpoint(path, { withHost: true });

    await queueEvents(6);
    await drainWith(dispatchers());

    expect(arrivals).toHaveLength(36);
    expect(peakTotal).toBeGreaterThan(5);
  }, 90_000);

  it("leaves an endpoint with no host recorded out of the host cap", async () => {
    env.WEBHOOK_HOST_GLOBAL_CONCURRENCY = 5;

    // As an older image saves them, until the minute fills the host.
    for (const path of PATHS) await seedEndpoint(path);

    await queueEvents(6);
    await drainWith(dispatchers());

    expect(arrivals).toHaveLength(36);
    expect(peakTotal).toBeGreaterThan(5);
  }, 90_000);

  it("is written with the URL, and filled for the endpoints without one", async () => {
    const repository = new WebhookEndpointRepository(prisma as never);

    const created = await repository.createWithinQuota(
      CARRIER,
      {
        name: "ERP do agregador",
        url: "https://Api.Example.com./webhooks?tenant=1",
        secret: "selado",
        topics: ["delivery.delivered"],
        headers: null,
        is_active: true,
      },
      10,
    );

    const hostOf = async () =>
      (
        await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: created!.id },
        })
      ).destination_host;

    expect(await hostOf()).toBe("api.example.com");

    await repository.update(created!.id, CARRIER, {
      name: "ERP do agregador",
      url: "https://outro.example.com:8443/hook",
      topics: ["delivery.delivered"],
      is_active: true,
    });

    expect(await hostOf()).toBe("outro.example.com");

    // Saved by the image of before: no host until the minute's fill.
    await prisma.webhookEndpoint.update({
      where: { id: created!.id },
      data: { destination_host: null },
    });

    const before = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: created!.id },
    });

    const filled = await dispatchers()[0].fillDestinationHosts();

    expect(filled).toBeGreaterThanOrEqual(1);
    expect(await hostOf()).toBe("outro.example.com");

    // The screen's "updated at" does not move for it.
    const after = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: created!.id },
    });

    expect(after.updated_at).toEqual(before.updated_at);
  });
});

describe("endpoints with nothing to take ahead of the cursor (F3-13 review)", () => {
  // The capped claim walked at most WEBHOOK_CLAIM_MAX_ENDPOINTS endpoints,
  // probed every endpoint with a row in the queue (due or not), filled
  // nothing past the shares and kept the cursor when it took nothing. So
  // 64 endpoints in a row with nothing claimable — rows parked for a
  // paused endpoint for up to 30 days, or an aggregator's endpoints at
  // their host's cap — held every webhook after them: each claim visited
  // the same 64 and came back empty.
  const RUN = WEBHOOK_CLAIM_MAX_ENDPOINTS + 6;

  /** Endpoint ids that sort in the order of `n`; a run leaves gaps. */
  const idOf = (n: number) =>
    `018f8000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

  const LATE = idOf(0xffffff);

  async function seedRun(options: {
    count: number;
    host?: string;
    availableAt: Date;
    first?: number;
  }): Promise<string[]> {
    const ids = Array.from({ length: options.count }, (_, n) =>
      idOf(((options.first ?? 0x1000) + n) * 0x10),
    );

    await prisma.webhookEndpoint.createMany({
      data: ids.map((id, n) => ({
        id,
        name: `Endpoint ${n}`,
        url: `https://${options.host ?? "parado.example.com"}/hook/${n}`,
        destination_host: options.host ?? null,
        secret: "whsec_teste_do_teto_global",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
        is_active: true,
      })),
    });

    await prisma.webhookDelivery.createMany({
      data: ids.map((endpointId) => ({
        endpointId,
        topic: "delivery.delivered",
        payload: { delivery_id: endpointId },
        signature: "sig",
        status: "PENDING" as const,
        availableAt: options.availableAt,
        businessId: CARRIER,
      })),
    });

    return ids;
  }

  async function seedLate(rows: number, id = LATE): Promise<void> {
    await prisma.webhookEndpoint.create({
      data: {
        id,
        name: "Receptor de outro cliente",
        url: `${baseUrl}/late`,
        destination_host: destinationHostOf(`${baseUrl}/late`),
        secret: "whsec_teste_do_teto_global",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
        is_active: true,
      },
    });

    await prisma.webhookDelivery.createMany({
      data: Array.from({ length: rows }, (_, n) => ({
        endpointId: id,
        topic: "delivery.delivered",
        payload: { delivery_id: `late-${n}` },
        signature: "sig",
        status: "PENDING" as const,
        availableAt: new Date(Date.now() - 60_000),
        businessId: CARRIER,
      })),
    });
  }

  const thirtyDaysAhead = () => new Date(Date.now() + 30 * 24 * 3_600_000);

  it("reaches an endpoint with due rows behind more parked endpoints than one walk visits", async () => {
    const parked = await seedRun({
      count: RUN,
      availableAt: thirtyDaysAhead(),
    });
    await seedLate(3);

    await new WebhookDispatchService(async () => ({
      allowed: true,
    })).processBatch();

    expect(arrivals.filter((path) => path === "/late")).toHaveLength(3);

    // The parked rows stay parked, their attempts untouched.
    const held = await prisma.webhookDelivery.findMany({
      where: { endpointId: { in: parked } },
    });

    expect(held).toHaveLength(RUN);
    expect(held.every((row) => row.status === "PENDING")).toBe(true);
    expect(held.every((row) => row.attempts === 0)).toBe(true);
  }, 60_000);

  it("reaches another host's endpoint behind an aggregator's endpoints at their host's cap", async () => {
    env.WEBHOOK_HOST_GLOBAL_CONCURRENCY = 1;

    // An aggregator's ERP: one endpoint per tenant, every one with a due
    // row, and the host already at its cap with one call in flight.
    const aggregator = await seedRun({
      count: RUN,
      host: "erp.example.com",
      availableAt: new Date(Date.now() - 60_000),
    });

    await prisma.webhookDelivery.create({
      data: {
        endpointId: aggregator[0],
        topic: "delivery.delivered",
        payload: { delivery_id: "em-voo" },
        signature: "sig",
        status: "PROCESSING",
        attempts: 1,
        availableAt: new Date(Date.now() + 5 * 60_000),
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        businessId: CARRIER,
      },
    });

    await seedLate(1);

    await new WebhookDispatchService(async () => ({
      allowed: true,
    })).processBatch();

    expect(arrivals).toEqual(["/late"]);

    // Nothing of the aggregator's left the queue past its host's cap.
    const claimed = await prisma.webhookDelivery.count({
      where: { endpointId: { in: aggregator }, status: { not: "PENDING" } },
    });

    expect(claimed).toBe(1);
  }, 60_000);

  it("reaches an endpoint before the cursor through the wrap, past more than one walk", async () => {
    // The cursor sits after a hundred parked endpoints; the endpoint with
    // due rows sorts after the first walk's worth of them, so the lap
    // wraps, is cut, and goes on from the wrap up to where it started.
    const parked = await seedRun({
      count: 130,
      availableAt: thirtyDaysAhead(),
    });
    await seedLate(
      2,
      idOf((0x1000 + WEBHOOK_CLAIM_MAX_ENDPOINTS - 1) * 0x10 + 1),
    );

    const dispatcher = new WebhookDispatchService(async () => ({
      allowed: true,
    }));

    // Where an earlier claim of this process stopped (private on purpose:
    // nothing but the claim moves it).
    (dispatcher as unknown as { endpointCursor: string }).endpointCursor =
      parked[100];

    await dispatcher.processBatch();

    expect(arrivals.filter((path) => path === "/late")).toHaveLength(2);
  }, 60_000);

  it("closes the lap and claims nothing when no endpoint has anything due", async () => {
    await seedRun({ count: 2 * RUN, availableAt: thirtyDaysAhead() });

    const claimed = await new WebhookDispatchService(async () => ({
      allowed: true,
    })).processBatch();

    expect(claimed).toBe(0);
    expect(arrivals).toEqual([]);
    expect(
      await prisma.webhookDelivery.count({
        where: { businessId: CARRIER, status: "PENDING", attempts: 0 },
      }),
    ).toBe(2 * RUN);
  }, 60_000);
});
