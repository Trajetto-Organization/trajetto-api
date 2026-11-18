import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
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
 *  - the cap is read at every claim.
 */
const prisma = createPrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000013ca";

/** How long the receiver holds each request open. */
const HOLD_MS = 250;

let server: Server;
let baseUrl: string;

/** Requests open now and at most, per path; arrivals in order. */
const open = new Map<string, number>();
const peak = new Map<string, number>();
let arrivals: string[] = [];

const saved = env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY;

/** Three dispatchers, as three worker processes would run them. */
function dispatchers(): WebhookDispatchService[] {
  return [1, 2, 3].map(
    () => new WebhookDispatchService(async () => ({ allowed: true })),
  );
}

async function seedEndpoint(path: string): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `Receptor ${path}`,
      url: `${baseUrl}${path}`,
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
      arrivals.push(path);

      setTimeout(() => {
        open.set(path, (open.get(path) ?? 1) - 1);
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
  arrivals = [];
  env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY = 4;

  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  env.WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY = saved;

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
